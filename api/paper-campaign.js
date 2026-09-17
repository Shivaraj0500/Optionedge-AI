import { db } from 'hatchable';
import { INTRADAY_SQUARE_OFF, minutesOf as policyMinutesOf } from 'lib/trading-policy.js';

export const access = 'user';
export const methods = ['GET', 'POST'];

const ALLOWED = new Set(['NIFTY 50', 'BANK NIFTY', 'SENSEX', 'BANKEX']);

function minutesOf(value) {
  const [h, m] = String(value || '00:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function nowIstMinutes() {
  const now = new Date(Date.now() + 330 * 60 * 1000);
  return minutesOf(now.toISOString().slice(11, 16));
}

export default async function(req, res) {
  const user = req.user;
  if (req.method === 'GET') {
    const { rows } = await db.query('SELECT * FROM paper_campaigns WHERE user_id = $1 ORDER BY started_at DESC LIMIT 25', [user.id]);
    return res.json({ campaigns: rows });
  }
  const b = req.body || {};
  const strategyId = String(b.strategy_id || '');
  if (!strategyId) return res.status(400).json({ error: 'strategy_id required' });
  const strategyQ = await db.query('SELECT id, underlying, version, enabled, start_time, square_off FROM strategy_configs WHERE id=$1 AND user_id=$2 LIMIT 1', [strategyId, user.id]);
  const strategy = strategyQ.rows[0];
  if (!strategy) return res.status(404).json({ error: 'STRATEGY_NOT_FOUND' });
  const underlying = String(b.underlying || strategy.underlying || 'NIFTY 50');
  if (!ALLOWED.has(underlying) || underlying !== strategy.underlying) return res.status(400).json({ error: 'UNDERLYING_MISMATCH' });
  const requestedVersionId = String(b.strategy_version_id || '');
  const requestedVersion = Number(b.strategy_version || 0);
  const versionQ = requestedVersionId
    ? await db.query('SELECT id, version_number, status, config FROM strategy_versions WHERE id=$1 AND strategy_id=$2 AND user_id=$3 LIMIT 1', [requestedVersionId, strategyId, user.id])
    : await db.query('SELECT id, version_number, status, config FROM strategy_versions WHERE strategy_id=$1 AND user_id=$2 AND version_number=$3 LIMIT 1', [strategyId, user.id, requestedVersion || Number(strategy.version || 1)]);
  if (!versionQ.rows[0]) return res.status(409).json({ error: 'STRATEGY_VERSION_NOT_FOUND', version: requestedVersion || Number(strategy.version || 1) });
  if (!['VALIDATED','ACTIVE'].includes(String(versionQ.rows[0].status).toUpperCase())) return res.status(409).json({ error: 'STRATEGY_VERSION_NOT_VALIDATED', status: versionQ.rows[0].status });
  const version = Number(versionQ.rows[0].version_number);
  const strategyVersionId = versionQ.rows[0].id;

  // Starting paper mode outside the strategy's configured trading window is a
  // normal market-closed condition, not a recovery incident. Do this preflight
  // before creating a RUNNING campaign or fetching broker market data.
  const startMinutes = minutesOf(strategy.start_time || '09:45');
  const squareOffMinutes = policyMinutesOf(INTRADAY_SQUARE_OFF);
  const nowMinutes = nowIstMinutes();
  const withinWindow = nowMinutes >= startMinutes && nowMinutes < squareOffMinutes;
  if (!withinWindow) {
    return res.status(409).json({
      error: 'PAPER_MARKET_CLOSED',
      reason: nowMinutes < startMinutes ? 'BEFORE_STRATEGY_START' : 'AFTER_STRATEGY_SQUARE_OFF',
      start_time: strategy.start_time || '09:45',
      square_off: strategy.square_off || '15:15',
      broker_orders_sent: false
    });
  }

  const { rows: running } = await db.query("SELECT id FROM paper_campaigns WHERE user_id = $1 AND status = 'RUNNING' LIMIT 1", [user.id]);
  if (running.length) return res.status(409).json({ error: 'PAPER_CAMPAIGN_ALREADY_RUNNING', campaign_id: running[0].id });
  const { rows } = await db.query('INSERT INTO paper_campaigns (user_id, strategy_id, strategy_version_id, underlying, status, mode, strategy_version, last_status, last_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [user.id, strategyId, strategyVersionId, underlying, 'RUNNING', 'LIVE_MARKET_PAPER', version, 'STARTED', 'CAMPAIGN_STARTED']);
  return res.status(201).json({ campaign: rows[0], broker_orders_sent: false, mode: 'LIVE_MARKET_PAPER', strategy_version: version });
}