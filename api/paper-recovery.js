import { db } from 'hatchable';
import { INTRADAY_SQUARE_OFF, minutesOf as policyMinutesOf } from 'lib/trading-policy.js';

export const access = 'user';
export const methods = ['GET'];

const STALE_SECONDS = 300;

function minutesOf(value) {
  const [h, m] = String(value || '00:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function nowIstMinutes() {
  const now = new Date(Date.now() + 330 * 60 * 1000);
  return minutesOf(now.toISOString().slice(11, 16));
}

export default async function(req, res) {
  const userId = req.user.id;
  const q = await db.query("SELECT * FROM paper_campaigns WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1", [userId]);
  const campaign = q.rows[0] || null;
  if (!campaign) return res.json({ status: 'READY', recovery_required: false, campaign: null, reasons: [] });

  const lq = await db.query("SELECT status, COUNT(*)::int AS count FROM paper_campaign_legs WHERE user_id=$1 AND campaign_id=$2 GROUP BY status", [userId, campaign.id]);
  const counts = Object.fromEntries(lq.rows.map(x => [x.status, Number(x.count)]));
  const lastCycle = campaign.last_cycle_at ? new Date(campaign.last_cycle_at).getTime() : null;
  const startedAt = campaign.started_at ? new Date(campaign.started_at).getTime() : null;
  const age = lastCycle ? Math.max(0, (Date.now() - lastCycle) / 1000) : null;
  const startedAge = startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : null;
  const strategyQ = await db.query('SELECT start_time, square_off FROM strategy_configs WHERE id=$1 AND user_id=$2 LIMIT 1', [campaign.strategy_id, userId]);
  const strategy = strategyQ.rows[0] || {};
  const nowMinutes = nowIstMinutes();
  const startMinutes = minutesOf(strategy.start_time || '09:45');
  const squareOffMinutes = policyMinutesOf(INTRADAY_SQUARE_OFF);
  const withinTradingWindow = nowMinutes >= startMinutes && nowMinutes < squareOffMinutes;
  // A persistent campaign is intentionally idle outside its trading window.
  // Do not classify that idle period as stale/recovery-required when there are
  // no open legs. Open exposure remains subject to normal recovery checks.
  const stale = campaign.status === 'RUNNING' && lastCycle && age > STALE_SECONDS && (withinTradingWindow || (counts.OPEN || 0) > 0);
  const errored = campaign.status === 'RUNNING' && (String(campaign.last_status || '').toUpperCase().includes('ERROR') || String(campaign.last_status || '').toUpperCase() === 'EMERGENCY_CLOSE_FAILED');
  const lockActive = campaign.cycle_lock_until && new Date(campaign.cycle_lock_until).getTime() > Date.now();
  const reasons = [];

  // A first-cycle MARKET_DATA_STALE outside the strategy window is a normal
  // closed-market condition, not a trading-state failure. Only reconcile when
  // there are zero open legs; never hide an unresolved position.
  const lastReason = String(campaign.last_reason || '').toUpperCase();
  const staleMarketFailure = campaign.status === 'RUNNING'
    && (counts.OPEN || 0) === 0
    && (lastReason === 'MARKET_DATA_STALE' || lastReason.includes('MARKET_DATA_STALE'));
  let marketClosedReconciled = false;
  if (staleMarketFailure) {
    const strategyQ = await db.query('SELECT start_time, square_off FROM strategy_configs WHERE id=$1 AND user_id=$2 LIMIT 1', [campaign.strategy_id, userId]);
    const strategy = strategyQ.rows[0] || {};
    const nowMinutes = nowIstMinutes();
    const startMinutes = minutesOf(strategy.start_time || '09:45');
    const squareOffMinutes = policyMinutesOf(INTRADAY_SQUARE_OFF);
    const outsideWindow = nowMinutes < startMinutes || nowMinutes >= squareOffMinutes;
    if (outsideWindow) {
      await db.query("UPDATE paper_campaigns SET status='CLOSED', closed_at=now(), last_status='MARKET_CLOSED', last_reason='OUTSIDE_TRADING_WINDOW', cycle_lock_until=null, recovery_required=false, updated_at=now() WHERE id=$1 AND user_id=$2 AND status='RUNNING'", [campaign.id, userId]);
      campaign.status = 'CLOSED';
      campaign.last_status = 'MARKET_CLOSED';
      campaign.last_reason = 'OUTSIDE_TRADING_WINDOW';
      campaign.cycle_lock_until = null;
      campaign.recovery_required = false;
      marketClosedReconciled = true;
    }
  }
  if (stale && !marketClosedReconciled) reasons.push('STALE_RUNNING_CAMPAIGN');
  if (errored && !marketClosedReconciled) reasons.push('LAST_CYCLE_ERROR');
  if (campaign.recovery_required && !marketClosedReconciled) reasons.push('RECOVERY_FLAGGED');

  const orphanOpenLegs = (campaign.status !== 'RUNNING') && (counts.OPEN || 0) > 0;
  // A newly-created RUNNING campaign legitimately has no cycle timestamp until
  // its first engine evaluation. Only treat it as recovery-required if it has
  // remained cycle-less beyond the recovery grace period.
  const runningWithoutCycle = campaign.status === 'RUNNING' && !lastCycle && (!startedAt || startedAge > STALE_SECONDS) && (withinTradingWindow || (counts.OPEN || 0) > 0);
  if (orphanOpenLegs) reasons.push('OPEN_LEGS_ON_NON_RUNNING_CAMPAIGN');
  if (runningWithoutCycle) reasons.push('RUNNING_CAMPAIGN_WITHOUT_CYCLE_TIMESTAMP');

  // A terminal campaign with zero open legs is fully reconciled. A stale
  // recovery flag can remain after a successful square-off if a later
  // response/telemetry operation failed; do not keep a clean terminal
  // campaign permanently blocked in that case.
  const terminalClean = ['CLOSED', 'STOPPED'].includes(String(campaign.status || '').toUpperCase()) && (counts.OPEN || 0) === 0;
  if (terminalClean && campaign.recovery_required && !orphanOpenLegs) {
    await db.query('UPDATE paper_campaigns SET recovery_required=false, cycle_lock_until=null, updated_at=now() WHERE id=$1 AND user_id=$2', [campaign.id, userId]);
    campaign.recovery_required = false;
    campaign.cycle_lock_until = null;
    const flagIndex = reasons.indexOf('RECOVERY_FLAGGED');
    if (flagIndex >= 0) reasons.splice(flagIndex, 1);
  }

  const required = reasons.length > 0;
  if (required !== Boolean(campaign.recovery_required)) {
    await db.query('UPDATE paper_campaigns SET recovery_required=$1, updated_at=now() WHERE id=$2 AND user_id=$3', [required, campaign.id, userId]);
  }

  return res.json({
    status: required ? 'RECOVERY_REQUIRED' : 'HEALTHY',
    recovery_required: required,
    campaign: {
      id: campaign.id,
      status: campaign.status,
      last_status: campaign.last_status,
      last_reason: campaign.last_reason,
      last_cycle_at: campaign.last_cycle_at,
      cycle_lock_until: campaign.cycle_lock_until
    },
    timing: { stale_after_seconds: STALE_SECONDS, last_cycle_age_seconds: age === null ? null : Math.round(age), started_age_seconds: startedAge === null ? null : Math.round(startedAge), cycle_lock_active: Boolean(lockActive) },
    legs: { open: counts.OPEN || 0, closed: counts.CLOSED || 0, total: Object.values(counts).reduce((a,b)=>a+b,0) },
    reasons,
    action: required ? 'Do not resume automated cycles until campaign state, market data, and open legs are reconciled.' : 'No recovery condition detected.'
  });
}