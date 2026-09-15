import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

const UNDERLYINGS = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'BANK NIFTY': 'NSE_INDEX|Nifty Bank',
  'SENSEX': 'BSE_INDEX|SENSEX',
  'BANKEX': 'BSE_INDEX|BANKEX'
};

export default async function(req, res) {
  const underlying = req.query?.underlying || 'NIFTY 50';
  const instrumentKey = UNDERLYINGS[underlying];
  if (!instrumentKey) return res.status(400).json({ error: 'Unsupported underlying.' });

  const { rows } = await db.query('SELECT access_token, expires_at, status FROM broker_connections WHERE user_id = $1', [req.user.id]);
  const connection = rows[0];
  if (!connection || connection.status !== 'CONNECTED' || !connection.access_token) {
    return res.status(409).json({ error: 'UPSTOX_NOT_CONNECTED' });
  }
  if (connection.expires_at && new Date(connection.expires_at).getTime() <= Date.now()) {
    return res.status(409).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
  }

  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token };
  const url = 'https://api.upstox.com/v2/option/chain?instrument_key=' + encodeURIComponent(instrumentKey) + '&expiry_date=current_week';
  const r = await fetch(url, { headers });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
    return res.status(401).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
  }
  if (!r.ok || data.status !== 'success') {
    return res.status(502).json({ error: 'UPSTOX_MARKET_DATA_FAILED', upstream_status: r.status });
  }

  const rowsData = Array.isArray(data.data) ? data.data : [];
  const spot = rowsData[0]?.underlying_spot_price ?? null;
  const expiry = rowsData[0]?.expiry ?? null;
  const contracts = rowsData.map(x => ({
    strike: x.strike_price,
    call: x.call_options ? { instrument_key: x.call_options.instrument_key, market: x.call_options.market_data || {}, greeks: x.call_options.option_greeks || {} } : null,
    put: x.put_options ? { instrument_key: x.put_options.instrument_key, market: x.put_options.market_data || {}, greeks: x.put_options.option_greeks || {} } : null
  }));

  return res.json({ source: 'UPSTOX', underlying, instrument_key: instrumentKey, expiry, spot, contracts });
}