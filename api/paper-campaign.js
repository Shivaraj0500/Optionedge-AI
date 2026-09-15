import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET', 'POST'];

const ALLOWED = new Set(['NIFTY 50', 'BANK NIFTY', 'SENSEX', 'BANKEX']);

export default async function(req, res) {
  const user = req.user;
  if (req.method === 'GET') {
    const { rows } = await db.query('SELECT * FROM paper_campaigns WHERE user_id = $1 ORDER BY started_at DESC LIMIT 25', [user.id]);
    return res.json({ campaigns: rows });
  }
  const b = req.body || {};
  const underlying = String(b.underlying || 'NIFTY 50');
  if (!ALLOWED.has(underlying)) return res.status(400).json({ error: 'Unsupported underlying.' });
  const strategyId = b.strategy_id || null;
  const { rows: running } = await db.query("SELECT id FROM paper_campaigns WHERE user_id = $1 AND status = 'RUNNING' LIMIT 1", [user.id]);
  if (running.length) return res.status(409).json({ error: 'PAPER_CAMPAIGN_ALREADY_RUNNING', campaign_id: running[0].id });
  const { rows } = await db.query('INSERT INTO paper_campaigns (user_id, strategy_id, underlying, status, mode) VALUES ($1,$2,$3,$4,$5) RETURNING *', [user.id, strategyId, underlying, 'RUNNING', 'LIVE_MARKET_PAPER']);
  return res.status(201).json({ campaign: rows[0], broker_orders_sent: false, mode: 'LIVE_MARKET_PAPER' });
}