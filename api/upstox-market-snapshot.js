import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

const UNDERLYINGS = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'BANK NIFTY': 'NSE_INDEX|Nifty Bank',
  'SENSEX': 'BSE_INDEX|SENSEX',
  'BANKEX': 'BSE_INDEX|BANKEX'
};
const EXPIRIES = new Set(['current_week', 'next_week', 'far_week', 'current_month', 'next_month', 'far_month']);

export default async function(req, res) {
  const underlying = req.query?.underlying || 'NIFTY 50';
  const instrumentKey = UNDERLYINGS[underlying];
  const expiryRequest = req.query?.expiry || 'current_week';
  if (!instrumentKey) return res.status(400).json({ error: 'UNSUPPORTED_UNDERLYING' });
  if (!EXPIRIES.has(expiryRequest) && !/^\d{4}-\d{2}-\d{2}$/.test(expiryRequest)) return res.status(400).json({ error: 'INVALID_EXPIRY' });

  const { rows } = await db.query('SELECT access_token, expires_at, status FROM broker_connections WHERE user_id = $1', [req.user.id]);
  const connection = rows[0];
  if (!connection || connection.status !== 'CONNECTED' || !connection.access_token) return res.status(409).json({ error: 'UPSTOX_NOT_CONNECTED' });
  if (connection.expires_at && new Date(connection.expires_at).getTime() <= Date.now()) return res.status(409).json({ error: 'UPSTOX_TOKEN_EXPIRED' });

  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token };
  const url = 'https://api.upstox.com/v2/option/chain?instrument_key=' + encodeURIComponent(instrumentKey) + '&expiry_date=' + encodeURIComponent(expiryRequest);
  const r = await fetch(url, { headers });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
    return res.status(401).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
  }
  if (!r.ok || data.status !== 'success') return res.status(502).json({ error: 'UPSTOX_MARKET_DATA_FAILED', upstream_status: r.status });

  const rowsData = Array.isArray(data.data) ? data.data : [];
  const spot = rowsData[0]?.underlying_spot_price ?? null;
  const expiry = rowsData[0]?.expiry ?? null;

  // The option-chain response is the live market source. The contracts API is
  // used only to enrich the same instrument keys with authoritative contract
  // metadata such as lot size, tick size and trading symbol.
  let metadata = [];
  if (expiry && rowsData.length) {
    const cr = await fetch(
      'https://api.upstox.com/v2/option/contract?instrument_key=' + encodeURIComponent(instrumentKey) + '&expiry_date=' + encodeURIComponent(expiry),
      { headers }
    );
    const cd = await cr.json().catch(() => ({}));
    if (cr.status === 401) {
      await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
      return res.status(401).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
    }
    if (cr.ok && cd.status === 'success' && Array.isArray(cd.data)) metadata = cd.data;
  }

  const metaByKey = new Map(metadata.map(x => [x.instrument_key, {
    trading_symbol: x.trading_symbol,
    instrument_type: x.instrument_type,
    lot_size: x.lot_size,
    minimum_lot: x.minimum_lot,
    tick_size: x.tick_size,
    freeze_quantity: x.freeze_quantity,
    weekly: x.weekly
  }]));

  const normalize = option => option ? {
    instrument_key: option.instrument_key,
    market: option.market_data || {},
    greeks: option.option_greeks || {},
    contract: metaByKey.get(option.instrument_key) || null
  } : null;

  const contracts = rowsData.map(x => ({
    strike: x.strike_price,
    pcr: x.pcr ?? null,
    call: normalize(x.call_options),
    put: normalize(x.put_options)
  }));

  return res.json({ source: 'UPSTOX', as_of: new Date().toISOString(), underlying, instrument_key: instrumentKey, expiry_request: expiryRequest, expiry, spot, count: contracts.length, contracts });
}