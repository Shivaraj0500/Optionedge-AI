import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

export default async function(req, res) {
  const user = req.user;
  const q = req.query || {};
  const status = String(q.status || 'ALL').toUpperCase();
  const underlying = String(q.underlying || 'ALL');
  const limit = Math.min(Math.max(Number(q.limit || 500), 1), 1000);

  const params = [user.id];
  const where = ['l.user_id = $1'];
  if (status !== 'ALL' && ['OPEN', 'CLOSED'].includes(status)) {
    params.push(status);
    where.push(`l.status = $${params.length}`);
  }
  if (underlying !== 'ALL') {
    params.push(underlying);
    where.push(`c.underlying = $${params.length}`);
  }
  params.push(limit);

  const { rows } = await db.query(`
    SELECT
      l.id,
      l.campaign_id,
      l.strategy_id,
      l.strategy_version,
      l.cycle_id,
      l.leg_id,
      l.role,
      l.side,
      l.option_type,
      l.execution_rank,
      l.expiry,
      l.strike,
      l.instrument_key,
      l.trading_symbol,
      l.lot_size,
      l.lots,
      l.quantity,
      l.entry_price,
      l.exit_price,
      l.current_price,
      l.pnl,
      l.status,
      l.entry_at,
      l.exit_at,
      l.last_mark_at,
      l.metadata,
      c.underlying,
      c.mode AS campaign_mode,
      c.status AS campaign_status,
      c.started_at AS campaign_started_at,
      c.closed_at AS campaign_closed_at
    FROM paper_campaign_legs l
    JOIN paper_campaigns c ON c.id = l.campaign_id AND c.user_id = l.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(l.exit_at, l.entry_at) DESC, l.execution_rank ASC
    LIMIT $${params.length}
  `, params);

  const trades = rows.map(r => ({
    ...r,
    strike: Number(r.strike),
    lot_size: Number(r.lot_size),
    lots: Number(r.lots),
    quantity: Number(r.quantity),
    entry_price: Number(r.entry_price),
    exit_price: r.exit_price == null ? null : Number(r.exit_price),
    current_price: r.current_price == null ? null : Number(r.current_price),
    pnl: Number(r.pnl || 0),
    metadata: r.metadata || {}
  }));

  const closed = trades.filter(t => t.status === 'CLOSED');
  const open = trades.filter(t => t.status === 'OPEN');
  const realized = closed.reduce((s, t) => s + t.pnl, 0);
  const openPnl = open.reduce((s, t) => s + t.pnl, 0);
  const totalPnl = realized + openPnl;
  const campaigns = new Set(trades.map(t => t.campaign_id)).size;

  return res.json({
    trades,
    summary: {
      total_legs: trades.length,
      closed_legs: closed.length,
      open_legs: open.length,
      campaigns,
      realized_pnl: realized,
      open_pnl: openPnl,
      total_pnl: totalPnl
    },
    filters: { status, underlying, limit },
    source: 'OptionEdge AI paper ledger'
  });
}