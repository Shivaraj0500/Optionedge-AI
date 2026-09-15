import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

async function upstream(url, headers) {
  const r = await fetch(url, { headers });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
}

export default async function(req, res) {
  const { rows } = await db.query(
    'SELECT access_token, expires_at, status FROM broker_connections WHERE user_id = $1',
    [req.user.id]
  );
  const connection = rows[0];
  if (!connection || connection.status !== 'CONNECTED' || !connection.access_token) {
    return res.status(409).json({ error: 'UPSTOX_NOT_CONNECTED' });
  }
  if (connection.expires_at && new Date(connection.expires_at).getTime() <= Date.now()) {
    return res.status(409).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
  }

  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token };
  const [funds, positions, orders, market] = await Promise.all([
    upstream('https://api.upstox.com/v3/user/get-funds-and-margin', { ...headers, 'Api-Version': '3.0' }),
    upstream('https://api.upstox.com/v2/portfolio/short-term-positions', headers),
    upstream('https://api.upstox.com/v2/order/retrieve-all', headers),
    upstream('https://api.upstox.com/v2/market/status/NSE', headers)
  ]);

  const responses = [funds, positions, orders, market];
  if (responses.some(x => x.status === 401)) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
    return res.status(401).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
  }

  const cleanFunds = funds.ok && funds.data?.status === 'success' ? funds.data.data : null;
  const cleanPositions = positions.ok && positions.data?.status === 'success' ? (positions.data.data || []) : null;
  const cleanOrders = orders.ok && (orders.data?.status === 'success' || Array.isArray(orders.data)) ? (orders.data?.data || orders.data || []) : null;
  const cleanMarket = market.ok && market.data?.status === 'success' ? market.data.data : null;

  return res.json({
    source: 'UPSTOX',
    as_of: new Date().toISOString(),
    market: { available: !!cleanMarket, status: cleanMarket?.status || null, last_updated: cleanMarket?.last_updated || null },
    funds: { available: !!cleanFunds, data: cleanFunds },
    positions: { available: !!cleanPositions, count: cleanPositions?.length || 0, data: cleanPositions },
    orders: { available: !!cleanOrders, count: cleanOrders?.length || 0, data: cleanOrders },
    endpoint_status: { funds: funds.status, positions: positions.status, orders: orders.status, market: market.status }
  });
}