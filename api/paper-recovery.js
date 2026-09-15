import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

const STALE_SECONDS = 300;

export default async function(req, res) {
  const userId = req.user.id;
  const q = await db.query("SELECT * FROM paper_campaigns WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1", [userId]);
  const campaign = q.rows[0] || null;
  if (!campaign) return res.json({ status: 'READY', recovery_required: false, campaign: null, reasons: [] });

  const lq = await db.query("SELECT status, COUNT(*)::int AS count FROM paper_campaign_legs WHERE user_id=$1 AND campaign_id=$2 GROUP BY status", [userId, campaign.id]);
  const counts = Object.fromEntries(lq.rows.map(x => [x.status, Number(x.count)]));
  const lastCycle = campaign.last_cycle_at ? new Date(campaign.last_cycle_at).getTime() : null;
  const age = lastCycle ? Math.max(0, (Date.now() - lastCycle) / 1000) : null;
  const stale = campaign.status === 'RUNNING' && lastCycle && age > STALE_SECONDS;
  const errored = campaign.status === 'RUNNING' && (String(campaign.last_status || '').toUpperCase().includes('ERROR') || String(campaign.last_status || '').toUpperCase() === 'EMERGENCY_CLOSE_FAILED');
  const lockActive = campaign.cycle_lock_until && new Date(campaign.cycle_lock_until).getTime() > Date.now();
  const reasons = [];
  if (stale) reasons.push('STALE_RUNNING_CAMPAIGN');
  if (errored) reasons.push('LAST_CYCLE_ERROR');
  if (campaign.recovery_required) reasons.push('RECOVERY_FLAGGED');

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
    timing: { stale_after_seconds: STALE_SECONDS, last_cycle_age_seconds: age === null ? null : Math.round(age), cycle_lock_active: Boolean(lockActive) },
    legs: { open: counts.OPEN || 0, closed: counts.CLOSED || 0, total: Object.values(counts).reduce((a,b)=>a+b,0) },
    reasons,
    action: required ? 'Do not resume automated cycles until campaign state, market data, and open legs are reconciled.' : 'No recovery condition detected.'
  });
}