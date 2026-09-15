import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

const UNDERLYINGS = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'BANK NIFTY': 'NSE_INDEX|Nifty Bank',
  'SENSEX': 'BSE_INDEX|SENSEX',
  'BANKEX': 'BSE_INDEX|BANKEX'
};
const TIMEFRAMES = { '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60 };

function istNow() {
  return new Date(Date.now() + 330 * 60 * 1000);
}
function dateOnly(d) { return d.toISOString().slice(0, 10); }
function shiftDate(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return dateOnly(d);
}
function intervalParts(tf) { return tf === '1h' ? ['hours', '1'] : ['minutes', String(TIMEFRAMES[tf])]; }
function completed(ts, minutes, nowMs) {
  const start = new Date(ts).getTime();
  return start + minutes * 60000 <= nowMs;
}
function calculateIndicators(candles, adxPeriod, atrPeriod) {
  if (candles.length < Math.max(adxPeriod * 2 + 1, atrPeriod + 1)) return null;
  const tr = [], plusDm = [], minusDm = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1], cur = candles[i];
    const high = Number(cur.high), low = Number(cur.low), prevClose = Number(prev.close);
    const up = high - Number(prev.high);
    const down = Number(prev.low) - low;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  if (tr.length < Math.max(adxPeriod, atrPeriod)) return null;

  // Wilder's smoothing is applied independently to ATR and directional movement.
  // Values are carried across the warm-up window so the displayed number is not
  // based only on the current trading session.
  let atr = null, pDm = null, mDm = null;
  const dx = [];
  let plusDi = null, minusDi = null;
  for (let i = 0; i < tr.length; i++) {
    if (i === atrPeriod - 1) atr = tr.slice(0, atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod;
    else if (i >= atrPeriod) atr = ((atr * (atrPeriod - 1)) + tr[i]) / atrPeriod;

    if (i === adxPeriod - 1) {
      pDm = plusDm.slice(0, adxPeriod).reduce((a, b) => a + b, 0) / adxPeriod;
      mDm = minusDm.slice(0, adxPeriod).reduce((a, b) => a + b, 0) / adxPeriod;
    } else if (i >= adxPeriod) {
      pDm = ((pDm * (adxPeriod - 1)) + plusDm[i]) / adxPeriod;
      mDm = ((mDm * (adxPeriod - 1)) + minusDm[i]) / adxPeriod;
    }

    if (atr !== null && pDm !== null && mDm !== null && atr > 0) {
      plusDi = 100 * pDm / atr;
      minusDi = 100 * mDm / atr;
      const denom = plusDi + minusDi;
      dx.push(denom > 0 ? 100 * Math.abs(plusDi - minusDi) / denom : 0);
    }
  }
  if (dx.length < adxPeriod || atr === null || plusDi === null || minusDi === null) return null;
  let adx = dx.slice(0, adxPeriod).reduce((a, b) => a + b, 0) / adxPeriod;
  for (let i = adxPeriod; i < dx.length; i++) adx = ((adx * (adxPeriod - 1)) + dx[i]) / adxPeriod;
  return { adx, plus_di: plusDi, minus_di: minusDi, atr };
}

function parseCandles(rows) {
  return rows.map(x => ({
    timestamp: x[0], open: Number(x[1]), high: Number(x[2]), low: Number(x[3]), close: Number(x[4]), volume: Number(x[5] || 0), oi: Number(x[6] || 0)
  })).filter(x => [x.open, x.high, x.low, x.close].every(Number.isFinite));
}

export default async function(req, res) {
  const underlying = req.query?.underlying || 'NIFTY 50';
  const timeframe = req.query?.timeframe || '15m';
  const instrumentKey = UNDERLYINGS[underlying];
  const minutes = TIMEFRAMES[timeframe];
  const adxPeriod = Math.max(2, Number(req.query?.adx_period || 14));
  const atrPeriod = Math.max(2, Number(req.query?.atr_period || 14));
  const atrMultiplier = Number(req.query?.atr_multiplier || 2);
  if (!instrumentKey) return res.status(400).json({ error: 'UNSUPPORTED_UNDERLYING' });
  if (!minutes) return res.status(400).json({ error: 'INVALID_TIMEFRAME' });
  if (!Number.isFinite(atrMultiplier) || atrMultiplier <= 0) return res.status(400).json({ error: 'INVALID_ATR_MULTIPLIER' });

  const { rows } = await db.query('SELECT access_token, expires_at, status FROM broker_connections WHERE user_id = $1', [req.user.id]);
  const connection = rows[0];
  if (!connection || connection.status !== 'CONNECTED' || !connection.access_token) return res.status(409).json({ error: 'UPSTOX_NOT_CONNECTED' });
  if (connection.expires_at && new Date(connection.expires_at).getTime() <= Date.now()) return res.status(409).json({ error: 'UPSTOX_TOKEN_EXPIRED' });

  const now = Date.now();
  const ist = istNow();
  const toDate = dateOnly(ist);
  const lookbackDays = timeframe === '3m' || timeframe === '5m' ? 12 : timeframe === '15m' ? 20 : 45;
  const fromDate = shiftDate(toDate, -lookbackDays);
  const [unit, interval] = intervalParts(timeframe);
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token };

  // Historical V3 provides the warm-up window required by ADX/ATR. Intraday V3
  // is fetched as well so the current trading day's candles are authoritative.
  const historicalUrl = 'https://api.upstox.com/v3/historical-candle/' + encodeURIComponent(instrumentKey) + '/' + unit + '/' + interval + '/' + encodeURIComponent(toDate) + '/' + encodeURIComponent(fromDate);
  const intradayUrl = 'https://api.upstox.com/v3/historical-candle/intraday/' + encodeURIComponent(instrumentKey) + '/' + unit + '/' + interval;
  const [hr, ir] = await Promise.all([fetch(historicalUrl, { headers }), fetch(intradayUrl, { headers })]);
  const hd = await hr.json().catch(() => ({}));
  const id = await ir.json().catch(() => ({}));
  if (hr.status === 401 || ir.status === 401) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
    return res.status(401).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
  }
  if (!hr.ok || hd.status !== 'success') return res.status(502).json({ error: 'UPSTOX_HISTORICAL_DATA_FAILED', upstream_status: hr.status });
  if (!ir.ok || id.status !== 'success') return res.status(502).json({ error: 'UPSTOX_INTRADAY_DATA_FAILED', upstream_status: ir.status });

  const merged = new Map();
  for (const c of parseCandles(hd.data?.candles || [])) merged.set(c.timestamp, c);
  for (const c of parseCandles(id.data?.candles || [])) merged.set(c.timestamp, c);
  const all = [...merged.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const completedCandles = all.filter(c => completed(c.timestamp, minutes, now));
  const indicator = calculateIndicators(completedCandles, adxPeriod, atrPeriod);
  if (!indicator) return res.status(422).json({ error: 'INSUFFICIENT_CANDLES', candle_count: completedCandles.length, required: Math.max(adxPeriod * 2 + 1, atrPeriod + 1) });

  const last = completedCandles[completedCandles.length - 1];
  const spot = last.close;
  const upper = spot + atrMultiplier * indicator.atr;
  const lower = spot - atrMultiplier * indicator.atr;
  return res.json({
    source: 'UPSTOX',
    as_of: new Date().toISOString(),
    underlying,
    instrument_key: instrumentKey,
    timeframe,
    candle_type: 'OHLC',
    completed_candle: last.timestamp,
    candle_count: completedCandles.length,
    parameters: { adx_period: adxPeriod, atr_period: atrPeriod, atr_multiplier: atrMultiplier },
    indicators: {
      adx: indicator.adx,
      plus_di: indicator.plus_di,
      minus_di: indicator.minus_di,
      atr: indicator.atr,
      spot: spot,
      atr_upper: upper,
      atr_lower: lower
    }
  });
}