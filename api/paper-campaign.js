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
  const strategyId = String(b.strategy_id || '');
  if (!strategyId) return res.status(400).json({ error: 'strategy_id required' });
  const strategyQ = await db.query('SELECT id, underlying, version, enabled FROM strategy_configs WHERE id=$1 AND user_id=$2 LIMIT 1', [strategyId, user.id]);
  const strategy = strategyQ.rows[0];
  if (!strategy) return res.status(404).json({ error: 'STRATEGY_NOT_FOUND' });
  const underlying = String(b.underlying || strategy.underlying || 'NIFTY 50');
  if (!ALLOWED.has(underlying) || underlying !== strategy.underlying) return res.status(400).json({ error: 'UNDERLYING_MISMATCH' });
  const version = Number(strategy.version || 1);
  const versionQ = await db.query('SELECT id, version_number, status, config FROM strategy_versions WHERE strategy_id=$1 AND user_id=$2 AND version_number=$3 LIMIT 1', [strategyId, user.id, version]);
  if (!versionQ.rows[0]) return res.status(409).json({ error: 'STRATEGY_VERSION_NOT_FOUND', version });
  const { rows: running } = await db.query("SELECT id FROM paper_campaigns WHERE user_id = $1 AND status = 'RUNNING' LIMIT 1", [user.id]);
  if (running.length) return res.status(409).json({ error: 'PAPER_CAMPAIGN_ALREADY_RUNNING', campaign_id: running[0].id });
  const { rows } = await db.query('INSERT INTO paper_campaigns (user_id, strategy_id, underlying, status, mode, strategy_version, last_status, last_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [user.id, strategyId, underlying, 'RUNNING', 'LIVE_MARKET_PAPER', version, 'STARTED', 'CAMPAIGN_STARTED']);
  return res.status(201).json({ campaign: rows[0], broker_orders_sent: false, mode: 'LIVE_MARKET_PAPER', strategy_version: version });
}