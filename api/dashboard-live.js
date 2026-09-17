import { db } from 'hatchable';
import { INTRADAY_SQUARE_OFF, minutesOf } from 'lib/trading-policy.js';

export const access = 'user';
export const methods = ['GET'];

const INDEX_KEYS = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'BANK NIFTY': 'NSE_INDEX|Nifty Bank'
};

function n(v, fallback = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function marketSession(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  const day = ist.getUTCDay();
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const open = day >= 1 && day <= 5 && minutes >= 9 * 60 + 15 && minutes < minutesOf(INTRADAY_SQUARE_OFF);
  return { open, status: open ? 'OPEN' : (day === 0 || day === 6 ? 'WEEKEND' : minutes < 9 * 60 + 15 ? 'PRE_OPEN' : 'CLOSED'), checked_at: now.toISOString() };
}

async function broker(userId) {
  const q = await db.query('SELECT access_token, expires_at, status FROM broker_connections WHERE user_id=$1 LIMIT 1', [userId]);
  const c = q.rows[0];
  if (!c || c.status !== 'CONNECTED' || !c.access_token) throw new Error('UPSTOX_NOT_CONNECTED');
  if (c.expires_at && new Date(c.expires_at).getTime() <= Date.now()) throw new Error('UPSTOX_TOKEN_EXPIRED');
  return c;
}

async function liveLtp(connection, instrumentKeys) {
  const keys = [...new Set((instrumentKeys || []).filter(Boolean))];
  if (!keys.length) return {};
  const response = await fetch('https://api.upstox.com/v3/market-quote/ltp?instrument_key=' + encodeURIComponent(keys.join(',')), {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token }
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error('UPSTOX_TOKEN_EXPIRED');
  if (!response.ok || data.status !== 'success') throw new Error('UPSTOX_LTP_FAILED');
  const out = {};
  for (const [requestedKey, value] of Object.entries(data.data || {})) {
    const price = n(value?.last_price);
    if (price == null) continue;
    // Upstox can expose both the requested instrument key and a separate token.
    // Keep aliases so the dashboard always matches the instrument_key stored in our ledger.
    out[requestedKey] = price;
    if (value?.instrument_token) out[value.instrument_token] = price;
  }
  return out;
}

export default async function(req, res) {
  const userId = req.user.id;
  try {
    const session = marketSession();
    const connection = await broker(userId);
    const q = await db.query(`SELECT l.id,l.campaign_id,l.instrument_key,l.side,l.entry_price,l.current_price,l.pnl,l.quantity,l.status,l.last_mark_at,c.underlying FROM paper_campaign_legs l JOIN paper_campaigns c ON c.id=l.campaign_id AND c.user_id=l.user_id WHERE l.user_id=$1 AND l.status='OPEN' AND c.status='RUNNING' ORDER BY c.started_at DESC,l.execution_rank ASC`, [userId]);
    const rows = q.rows.map(t => ({
      ...t,
      entry_price: n(t.entry_price),
      current_price: n(t.current_price),
      pnl: n(t.pnl, 0),
      quantity: n(t.quantity, 0)
    }));
    const keys = [...new Set([
      INDEX_KEYS['NIFTY 50'],
      INDEX_KEYS['BANK NIFTY'],
      ...rows.map(t => t.instrument_key).filter(Boolean)
    ])];
    const quotes = session.open ? await liveLtp(connection, keys) : {};
    const trades = rows.map(t => {
      const price = session.open ? n(quotes[t.instrument_key]) : null;
      const current = price ?? t.current_price;
      const pnl = price != null && t.entry_price != null
        ? (t.side === 'BUY' ? 1 : -1) * (price - t.entry_price) * t.quantity
        : t.pnl;
      return { ...t, current_price: current, pnl, live_price: price != null, mark_source: price != null ? 'UPSTOX_LTP_V3' : 'STORED_PAPER_MARK' };
    });
    const liveTrades = trades.filter(t => t.live_price);
    if (liveTrades.length) {
      await db.transaction(liveTrades.map(t => ({
        sql: 'UPDATE paper_campaign_legs SET current_price=$1,pnl=$2,last_mark_at=now() WHERE id=$3 AND user_id=$4 AND status=$5',
        params: [t.current_price, t.pnl, t.id, userId, 'OPEN']
      })));
    }
    const indexPrices = {
      nifty: n(quotes[INDEX_KEYS['NIFTY 50']]),
      nifty_bank: n(quotes[INDEX_KEYS['BANK NIFTY']])
    };
    const runningPnl = trades.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
    const markTimes = rows.map(t => t.last_mark_at).filter(Boolean).map(v => new Date(v).getTime()).filter(Number.isFinite);
    const markAsOf = markTimes.length ? new Date(Math.max(...markTimes)).toISOString() : null;
    return res.json({
      source: 'OptionEdge AI Dashboard',
      as_of: new Date().toISOString(),
      mark_as_of: markAsOf,
      index_prices: indexPrices,
      market: session,
      running: {
        campaigns: [...new Set(trades.map(t => t.campaign_id))].length,
        legs: trades.length,
        pnl: runningPnl,
        trades
      }
    });
  } catch (e) {
    return res.status(409).json({ error: String(e?.message || 'DASHBOARD_LIVE_FAILED'), source: 'OptionEdge AI Dashboard' });
  }
}