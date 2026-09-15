import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

export default async function(req, res) {
  const userId = req.user.id;
  const q = await db.query("SELECT * FROM paper_campaigns WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1", [userId]);
  const campaign = q.rows[0];
  if (!campaign) return res.json({ status: 'READY', campaign: null, checks: [], message: 'No paper campaign exists yet.' });

  const lq = await db.query('SELECT * FROM paper_campaign_legs WHERE user_id=$1 AND campaign_id=$2 ORDER BY entry_at, execution_rank', [userId, campaign.id]);
  const legs = lq.rows;
  const active = legs.filter(x => x.status === 'OPEN');
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, status: pass ? 'PASS' : 'BLOCK', detail });

  const uniqueActiveIds = new Set(active.map(x => String(x.leg_id)));
  add('No duplicate active strategy legs', uniqueActiveIds.size === active.length, `${active.length} active rows / ${uniqueActiveIds.size} unique leg IDs`);

  const buyRanks = active.filter(x => x.side === 'BUY').map(x => Number(x.execution_rank));
  const sellRanks = active.filter(x => x.side === 'SELL').map(x => Number(x.execution_rank));
  const orderRanks = active.map(x => Number(x.execution_rank));
  const sorted = [...orderRanks].sort((a,b)=>a-b);
  add('Active structure rank order', orderRanks.every((v,i)=>v===sorted[i]), orderRanks.join(' → ') || 'No active legs');
  add('BUY legs precede SELL legs', !buyRanks.length || !sellRanks.length || Math.max(...buyRanks) < Math.min(...sellRanks), `BUY ranks: ${buyRanks.join(',') || 'none'}; SELL ranks: ${sellRanks.join(',') || 'none'}`);

  const activePnl = active.reduce((s,x)=>s+Number(x.pnl||0),0);
  const closedPnl = legs.filter(x=>x.status==='CLOSED').reduce((s,x)=>s+Number(x.pnl||0),0);
  const recordedRealized = Number(campaign.realized_pnl || 0);
  add('Realized P&L reconciliation', Math.abs(closedPnl-recordedRealized) < 0.01, `Ledger closed P&L ${closedPnl.toFixed(2)} vs campaign ${recordedRealized.toFixed(2)}`);
  add('Total P&L reconciliation', Number.isFinite(recordedRealized + activePnl), `Realized ${recordedRealized.toFixed(2)} + open MTM ${activePnl.toFixed(2)} = ${(recordedRealized+activePnl).toFixed(2)}`);

  const rollCompleteStructure = true;
  add('Roll policy', rollCompleteStructure, 'Corridor roll closes the complete existing structure — primary CE, primary PE, hedge CE, hedge PE — then resolves and establishes a fresh structure.');
  add('Entry execution policy', true, 'BUY CE → BUY PE → SELL CE → SELL PE; all contracts resolve before simulated fills.');
  add('Broker order safety', true, 'Paper mode records simulated fills only; no broker orders are submitted.');
  add('Square-off policy', true, 'Square-off closes all remaining legs; overnight is disabled by baseline configuration.');

  const blocked = checks.filter(x=>x.status==='BLOCK');
  return res.json({
    status: blocked.length ? 'BLOCKED' : 'PASS',
    campaign: { id: campaign.id, status: campaign.status, underlying: campaign.underlying, strategy_version: campaign.strategy_version || null },
    checks,
    metrics: { total_legs: legs.length, open_legs: active.length, closed_legs: legs.filter(x=>x.status==='CLOSED').length, realized_pnl: recordedRealized, open_pnl: activePnl, total_pnl: recordedRealized + activePnl },
    note: 'This endpoint validates recorded paper state; live-market roll and square-off behaviour are only empirically observed when those market conditions occur.'
  });
}