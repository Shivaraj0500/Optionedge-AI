import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

const LIVE_ORDERS_ENABLED = false;

export default async function(req, res) {
  const checkedAt = new Date().toISOString();
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  let dbOk = false;
  try {
    const q = await db.query('SELECT 1 AS ok');
    dbOk = q.rows?.[0]?.ok === 1;
    add('Database', dbOk ? 'PASS' : 'BLOCKED', dbOk ? 'Database query succeeded.' : 'Database health query returned an unexpected result.');
  } catch (e) {
    add('Database', 'BLOCKED', 'Database health query failed.');
  }

  let broker = null;
  try {
    const q = await db.query('SELECT status, expires_at, updated_at FROM broker_connections WHERE user_id=$1 LIMIT 1', [req.user.id]);
    broker = q.rows[0] || null;
    if (!broker) {
      add('Upstox connection', 'WATCH', 'No Upstox connection is configured for this account.');
    } else if (broker.expires_at && new Date(broker.expires_at).getTime() <= Date.now()) {
      add('Upstox connection', 'BLOCKED', 'Stored Upstox authorization is expired. Reconnect before broker-dependent operations.');
    } else if (broker.status !== 'CONNECTED') {
      add('Upstox connection', 'WATCH', `Stored broker status is ${broker.status || 'UNKNOWN'}.`);
    } else {
      add('Upstox connection', 'PASS', 'Stored broker connection is marked CONNECTED; live API reachability is verified separately by broker refresh.');
    }
  } catch (e) {
    add('Upstox connection', 'BLOCKED', 'Broker connection state could not be read.');
  }

  try {
    await db.query('SELECT user_id FROM risk_configs WHERE user_id=$1 LIMIT 1', [req.user.id]);
    add('Risk engine', 'PASS', 'User risk configuration is readable.');
  } catch (e) {
    add('Risk engine', 'BLOCKED', 'Risk configuration could not be read.');
  }

  try {
    const q = await db.query("SELECT id, status, last_status, last_cycle_at, recovery_required FROM paper_campaigns WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1", [req.user.id]);
    const campaign = q.rows[0] || null;
    if (!campaign) {
      add('Paper engine', 'PASS', 'No paper campaign is currently recorded for this account.');
    } else {
      const openQ = await db.query("SELECT COUNT(*)::int AS count FROM paper_campaign_legs WHERE user_id=$1 AND campaign_id=$2 AND status='OPEN'", [req.user.id, campaign.id]);
      const openLegs = Number(openQ.rows[0]?.count || 0);
      const inconsistent = campaign.status !== 'RUNNING' && openLegs > 0;
      if (campaign.recovery_required || inconsistent) {
        add('Paper engine', 'BLOCKED', campaign.recovery_required
          ? `Latest campaign is ${campaign.status || 'UNKNOWN'} and is flagged RECOVERY REQUIRED.`
          : `Latest campaign is ${campaign.status || 'UNKNOWN'} but has ${openLegs} open simulated legs.`);
      } else {
        add('Paper engine', 'PASS', `Latest campaign status: ${campaign.status || 'UNKNOWN'}; open simulated legs: ${openLegs}.`);
      }
    }
  } catch (e) {
    add('Paper engine', 'BLOCKED', 'Paper campaign state could not be read.');
  }

  try {
    const q = await db.query('SELECT candle_at FROM paper_decisions WHERE user_id=$1 ORDER BY cycle_at DESC LIMIT 1', [req.user.id]);
    const candleAt = q.rows[0]?.candle_at || null;
    if (!candleAt) add('Market-data freshness', 'WATCH', 'No paper-engine candle has been recorded yet.');
    else {
      const age = Math.max(0, (Date.now() - new Date(candleAt).getTime()) / 1000);
      add('Market-data freshness', age <= 300 ? 'PASS' : 'WATCH', `Latest recorded paper candle is ${Math.round(age)}s old; paper-engine freshness protection is stricter and may block stale cycles.`);
    }
  } catch (e) {
    add('Market-data freshness', 'WATCH', 'Freshness could not be evaluated because no paper decision state was available.');
  }

  add('Authentication boundary', 'PASS', 'Endpoint is protected by the signed-in user access boundary.');
  add('Live execution safety', LIVE_ORDERS_ENABLED ? 'BLOCKED' : 'PASS', LIVE_ORDERS_ENABLED ? 'Live broker execution is enabled.' : 'Real broker order placement, modification and cancellation remain disabled in this build.');

  const blocked = checks.filter(x => x.status === 'BLOCKED').length;
  const watch = checks.filter(x => x.status === 'WATCH').length;
  return res.json({
    status: blocked ? 'BLOCKED' : watch ? 'WATCH' : 'HEALTHY',
    checked_at: checkedAt,
    live_orders_enabled: LIVE_ORDERS_ENABLED,
    checks,
    broker: broker ? { status: broker.status, expires_at: broker.expires_at, updated_at: broker.updated_at } : null
  });
}