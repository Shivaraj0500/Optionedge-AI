import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET', 'POST'];

const DEFAULTS = {
  max_daily_loss: 50000,
  max_campaign_loss: 100000,
  max_position_quantity: 100000,
  max_rolls: 5,
  max_premium_exposure: 1000000,
  max_spread_pct: 10,
  stale_data_seconds: 1800,
  kill_switch: false
};

const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

async function config(userId) {
  const q = await db.query('SELECT * FROM risk_configs WHERE user_id=$1 LIMIT 1', [userId]);
  if (q.rows[0]) return q.rows[0];
  const ins = await db.query('INSERT INTO risk_configs (user_id) VALUES ($1) RETURNING *', [userId]);
  return ins.rows[0];
}

async function evaluate(userId, campaignId = null) {
  const cfg = await config(userId);
  const c = campaignId
    ? await db.query('SELECT * FROM paper_campaigns WHERE id=$1 AND user_id=$2 LIMIT 1', [campaignId, userId])
    : await db.query("SELECT * FROM paper_campaigns WHERE user_id=$1 AND status='RUNNING' ORDER BY started_at DESC LIMIT 1", [userId]);
  const campaign = c.rows[0] || null;
  const checks = [];
  const add = (name, pass, detail, severity='BLOCK') => checks.push({ name, status: pass ? 'PASS' : severity, detail });
  add('Kill switch', !cfg.kill_switch, cfg.kill_switch ? 'Kill switch is ACTIVE; new paper entries and rolls are blocked.' : 'Kill switch is inactive.');
  if (!campaign) return { status: cfg.kill_switch ? 'EMERGENCY' : 'SAFE', config: cfg, campaign: null, checks, metrics: {}, decision: cfg.kill_switch ? 'BLOCK' : 'ALLOW' };

  add('Recovery state', !campaign.recovery_required, campaign.recovery_required ? 'Campaign is flagged for recovery; automated cycles must remain blocked.' : 'No recovery flag is set.');
  const orphanQ = await db.query('SELECT COUNT(*)::int AS count FROM paper_campaign_legs WHERE campaign_id=$1 AND user_id=$2 AND status=\'OPEN\'', [campaign.id, userId]);
  const openCount = Number(orphanQ.rows[0]?.count || 0);
  add('Campaign/leg consistency', campaign.status === 'RUNNING' || openCount === 0, openCount && campaign.status !== 'RUNNING' ? `Non-running campaign has ${openCount} open leg(s).` : 'Campaign status and open-leg state are consistent.');

  const legsQ = await db.query('SELECT * FROM paper_campaign_legs WHERE campaign_id=$1 AND user_id=$2 ORDER BY execution_rank', [campaign.id, userId]);
  const legs = legsQ.rows;
  const open = legs.filter(x => x.status === 'OPEN');
  const todayQ = await db.query("SELECT COALESCE(SUM(pnl),0) AS pnl FROM paper_campaign_legs WHERE user_id=$1 AND status='CLOSED' AND entry_at >= CURRENT_DATE", [userId]);
  const dailyRealized = Number(todayQ.rows[0]?.pnl || 0);
  const realized = Number(campaign.realized_pnl || 0);
  const openPnl = open.reduce((s, x) => s + Number(x.pnl || 0), 0);
  const totalPnl = realized + openPnl;
  const rollQ = await db.query("SELECT COUNT(*)::int AS count FROM paper_decisions WHERE campaign_id=$1 AND user_id=$2 AND status='ROLL'", [campaign.id, userId]);
  const rolls = Number(rollQ.rows[0]?.count || 0);
  const grossPremium = open.reduce((s, x) => s + Math.abs(Number(x.entry_price || 0) * Number(x.quantity || 0)), 0);
  const maxQty = open.reduce((m, x) => Math.max(m, Number(x.quantity || 0)), 0);
  const lastDecisionQ = await db.query('SELECT candle_at, cycle_at FROM paper_decisions WHERE campaign_id=$1 AND user_id=$2 ORDER BY cycle_at DESC LIMIT 1', [campaign.id, userId]);
  const last = lastDecisionQ.rows[0];
  const age = last?.candle_at ? Math.max(0, (Date.now() - new Date(last.candle_at).getTime()) / 1000) : Infinity;

  add('Daily loss limit', dailyRealized > -n(cfg.max_daily_loss, DEFAULTS.max_daily_loss), `Daily realized P&L ${dailyRealized.toFixed(2)} vs floor -${n(cfg.max_daily_loss, DEFAULTS.max_daily_loss).toFixed(2)}`);
  add('Campaign loss limit', totalPnl > -n(cfg.max_campaign_loss, DEFAULTS.max_campaign_loss), `Campaign total P&L ${totalPnl.toFixed(2)} vs floor -${n(cfg.max_campaign_loss, DEFAULTS.max_campaign_loss).toFixed(2)}`);
  add('Position quantity limit', maxQty <= n(cfg.max_position_quantity, DEFAULTS.max_position_quantity), `Largest open leg quantity ${maxQty} vs max ${n(cfg.max_position_quantity, DEFAULTS.max_position_quantity)}`);
  add('Roll limit', rolls <= n(cfg.max_rolls, DEFAULTS.max_rolls), `Rolls ${rolls} vs max ${n(cfg.max_rolls, DEFAULTS.max_rolls)}`);
  add('Premium exposure limit', grossPremium <= n(cfg.max_premium_exposure, DEFAULTS.max_premium_exposure), `Open gross premium notional ${grossPremium.toFixed(2)} vs max ${n(cfg.max_premium_exposure, DEFAULTS.max_premium_exposure).toFixed(2)}`);
  add('Market data freshness', age <= n(cfg.stale_data_seconds, DEFAULTS.stale_data_seconds), `Latest completed candle age ${Number.isFinite(age) ? age.toFixed(0) : 'unknown'}s vs max ${n(cfg.stale_data_seconds, DEFAULTS.stale_data_seconds)}s`);

  const blocked = checks.some(x => x.status === 'BLOCK');
  return {
    status: blocked ? 'BLOCKED' : 'SAFE', config: cfg,
    campaign: { id: campaign.id, status: campaign.status, underlying: campaign.underlying },
    checks,
    metrics: { daily_realized: dailyRealized, realized_pnl: realized, open_pnl: openPnl, total_pnl: totalPnl, open_legs: open.length, max_open_quantity: maxQty, gross_premium_exposure: grossPremium, rolls, latest_candle_age_seconds: Number.isFinite(age) ? age : null },
    decision: blocked ? 'BLOCK' : 'ALLOW'
  };
}

export default async function(req, res) {
  const userId = req.user.id;
  if (req.method === 'GET') return res.json(await evaluate(userId, req.query?.campaign_id || null));
  const b = req.body || {};
  const current = await config(userId);
  const next = {
    max_daily_loss: Math.max(0, n(b.max_daily_loss, Number(current.max_daily_loss))),
    max_campaign_loss: Math.max(0, n(b.max_campaign_loss, Number(current.max_campaign_loss))),
    max_position_quantity: Math.max(1, Math.trunc(n(b.max_position_quantity, Number(current.max_position_quantity)))),
    max_rolls: Math.max(0, Math.trunc(n(b.max_rolls, Number(current.max_rolls)))),
    max_premium_exposure: Math.max(0, n(b.max_premium_exposure, Number(current.max_premium_exposure))),
    max_spread_pct: Math.max(0, n(b.max_spread_pct, Number(current.max_spread_pct))),
    stale_data_seconds: Math.max(60, Math.trunc(n(b.stale_data_seconds, Number(current.stale_data_seconds)))),
    kill_switch: typeof b.kill_switch === 'boolean' ? b.kill_switch : Boolean(current.kill_switch)
  };
  const q = await db.query('UPDATE risk_configs SET max_daily_loss=$1,max_campaign_loss=$2,max_position_quantity=$3,max_rolls=$4,max_premium_exposure=$5,max_spread_pct=$6,stale_data_seconds=$7,kill_switch=$8,updated_at=now() WHERE user_id=$9 RETURNING *', [next.max_daily_loss,next.max_campaign_loss,next.max_position_quantity,next.max_rolls,next.max_premium_exposure,next.max_spread_pct,next.stale_data_seconds,next.kill_switch,userId]);
  const result = await evaluate(userId, b.campaign_id || null);
  return res.json({ updated: q.rows[0], ...result });
}