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
  const expiry = req.query?.expiry || 'current_week';
  if (!instrumentKey) return res.status(400).json({ error: 'UNSUPPORTED_UNDERLYING' });
  if (!EXPIRIES.has(expiry) && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return res.status(400).json({ error: 'INVALID_EXPIRY' });

  const { rows } = await db.query('SELECT access_token, expires_at, status FROM broker_connections WHERE user_id = $1', [req.user.id]);
  const connection = rows[0];
  if (!connection || connection.status !== 'CONNECTED' || !connection.access_token) return res.status(409).json({ error: 'UPSTOX_NOT_CONNECTED' });
  if (connection.expires_at && new Date(connection.expires_at).getTime() <= Date.now()) return res.status(409).json({ error: 'UPSTOX_TOKEN_EXPIRED' });

  const url = 'https://api.upstox.com/v2/option/contract?instrument_key=' + encodeURIComponent(instrumentKey) + '&expiry_date=' + encodeURIComponent(expiry);
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token } });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
    return res.status(401).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
  }
  if (!r.ok || data.status !== 'success') return res.status(502).json({ error: 'UPSTOX_CONTRACT_DATA_FAILED', upstream_status: r.status });

  const contracts = Array.isArray(data.data) ? data.data.map(x => ({
    instrument_key: x.instrument_key,
    trading_symbol: x.trading_symbol,
    exchange: x.exchange,
    segment: x.segment,
    expiry: x.expiry,
    strike: x.strike_price,
    option_type: x.instrument_type,
    lot_size: x.lot_size,
    minimum_lot: x.minimum_lot,
    tick_size: x.tick_size,
    weekly: x.weekly,
    underlying_key: x.underlying_key
  })) : [];

  return res.json({ source: 'UPSTOX', underlying, instrument_key: instrumentKey, expiry, count: contracts.length, contracts });
}