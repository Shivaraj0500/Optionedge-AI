import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

export default async function(req, res) {
  const q = await db.query(
    'SELECT access_token, expires_at, status FROM broker_connections WHERE user_id=$1 LIMIT 1',
    [req.user.id]
  );
  const connection = q.rows[0];
  if (!connection || connection.status !== 'CONNECTED' || !connection.access_token) {
    return res.status(409).json({ error: 'UPSTOX_NOT_CONNECTED' });
  }
  if (connection.expires_at && new Date(connection.expires_at).getTime() <= Date.now()) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
    return res.status(401).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
  }

  const r = await fetch('https://api.upstox.com/v3/feed/market-data-feed/authorize', {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token }
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
    return res.status(401).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
  }
  if (!r.ok || data.status !== 'success' || !data.data?.authorized_redirect_uri) {
    return res.status(502).json({ error: 'UPSTOX_MARKET_FEED_AUTHORIZE_FAILED', detail: data.errors || data.message || null });
  }
  res.json({ authorized_redirect_uri: data.data.authorized_redirect_uri, source: 'UPSTOX_MARKET_DATA_FEED_V3' });
}