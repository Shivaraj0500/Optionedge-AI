import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

const instruments = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'BANK NIFTY': 'NSE_INDEX|Nifty Bank',
  'SENSEX': 'BSE_INDEX|SENSEX',
  'BANKEX': 'BSE_INDEX|BANKEX'
};

function wilder(values, period) {
  if (values.length < period + 1) return null;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += values[i];
  let avg = sum / period;
  for (let i = period + 1; i < values.length; i++) avg = (avg * (period - 1) + values[i]) / period;
  return avg;
}

function indicators(candles) {
  const rows = candles.slice().reverse();
  if (rows.length < 16) return { adx: null, atr: null, trend: 'FLAT', regime: 'PENDING' };
  const tr = [], plus = [], minus = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    const h = Number(cur[2]), l = Number(cur[3]), pc = Number(prev[4]);
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - Number(prev[2]);
    const down = Number(prev[3]) - l;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  const period = 14;
  const atr = wilder(tr, period);
  const p = wilder(plus, period), m = wilder(minus, period);
  let adx = null;
  if (atr && p !== null && m !== null && atr !== 0) {
    const pdi = 100 * p / atr, mdi = 100 * m / atr;
    const dx = (pdi + mdi) ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    adx = dx;
  }
  const close = Number(rows[rows.length - 1][4]), prevClose = Number(rows[rows.length - 2][4]);
  const trend = close > prevClose ? 'UP' : close < prevClose ? 'DOWN' : 'FLAT';
  return { adx: adx === null ? null : Number(adx.toFixed(2)), atr: atr === null ? null : Number(atr.toFixed(2)), trend, regime: adx === null ? 'PENDING' : adx < 22 ? 'RANGE' : 'TREND' };
}

export default async function(req, res) {
  const user = req.user;
  const underlying = String(req.query?.underlying || 'NIFTY 50');
  const instrumentKey = instruments[underlying];
  if (!instrumentKey) return res.status(400).json({ error: 'Unsupported underlying.' });

  const { rows } = await db.query('SELECT access_token, status, expires_at FROM broker_connections WHERE user_id = $1', [user.id]);
  const connection = rows[0];
  if (!connection || connection.status !== 'CONNECTED' || !connection.access_token) return res.status(409).json({ error: 'Connect Upstox before scanning the market.' });

  const token = connection.access_token;
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  try {
    const quoteUrl = 'https://api.upstox.com/v3/market-quote/quotes?instrument_key=' + encodeURIComponent(instrumentKey);
    const candleUrl = 'https://api.upstox.com/v3/historical-candle/intraday/' + encodeURIComponent(instrumentKey) + '/minutes/15';
    const chainUrl = 'https://api.upstox.com/v2/option/chain?instrument_key=' + encodeURIComponent(instrumentKey) + '&expiry_date=current_week';
    const [quoteRes, candleRes, chainRes] = await Promise.all([fetch(quoteUrl, { headers }), fetch(candleUrl, { headers }), fetch(chainUrl, { headers })]);
    const quote = await quoteRes.json();
    const candles = await candleRes.json();
    const chain = await chainRes.json();
    if (!quoteRes.ok || !candleRes.ok || !chainRes.ok) return res.status(502).json({ error: 'Upstox market data request failed.', details: { quote: quoteRes.status, candles: candleRes.status, chain: chainRes.status } });

    const quoteData = Object.values(quote.data || {})[0] || {};
    const spot = Number(quoteData.last_price ?? quoteData.lastPrice ?? 0);
    const ind = indicators(candles.data?.candles || []);
    const corridor = ind.atr ? { lower: Number((spot - 2 * ind.atr).toFixed(2)), upper: Number((spot + 2 * ind.atr).toFixed(2)) } : null;
    const options = Object.entries(chain.data || {}).map(([strike, item]) => ({ strike: Number(strike), ce: item?.call_options?.market_data || {}, pe: item?.put_options?.market_data || {}, ceGreeks: item?.call_options?.option_greeks || {}, peGreeks: item?.put_options?.option_greeks || {}, ceInstrument: item?.call_options?.instrument_key, peInstrument: item?.put_options?.instrument_key })).filter(x => Number.isFinite(x.strike));
    options.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    const atm = options[0] || null;
    return res.json({ underlying, instrument_key: instrumentKey, spot, ...ind, corridor, expiry: chain.data?.[String(atm?.strike)]?.expiry || null, atm: atm ? { strike: atm.strike, ce: { instrument_key: atm.ceInstrument, ltp: Number(atm.ce?.ltp || 0), oi: Number(atm.ce?.oi || 0), iv: Number(atm.ceGreeks?.iv || 0), delta: Number(atm.ceGreeks?.delta || 0) }, pe: { instrument_key: atm.peInstrument, ltp: Number(atm.pe?.ltp || 0), oi: Number(atm.pe?.oi || 0), iv: Number(atm.peGreeks?.iv || 0), delta: Number(atm.peGreeks?.delta || 0) } } : null, nearby: options.slice(0, 9) });
  } catch (e) {
    console.error('Market snapshot failed', e);
    return res.status(502).json({ error: 'Unable to retrieve live Upstox market data.' });
  }
}