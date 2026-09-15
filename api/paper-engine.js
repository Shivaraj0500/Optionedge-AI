import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET', 'POST'];

const UNDERLYINGS = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'BANK NIFTY': 'NSE_INDEX|Nifty Bank',
  'SENSEX': 'BSE_INDEX|SENSEX',
  'BANKEX': 'BSE_INDEX|BANKEX'
};
const TIMEFRAMES = { '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60 };
const SEQUENCE = { 'BUY:CE': 1, 'BUY:PE': 2, 'SELL:CE': 3, 'SELL:PE': 4 };
const ALLOWED_EXPIRIES = new Set(['current_week', 'next_week', 'far_week', 'current_month', 'next_month', 'far_month']);

const num = (v, fallback = NaN) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
function istDate(date = new Date()) { return new Date(date.getTime() + 330 * 60 * 1000); }
function dateOnly(d) { return d.toISOString().slice(0, 10); }
function timeOnly(d) { return d.toISOString().slice(11, 16); }
function minutesOf(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; }
function nowIstMinutes() { return minutesOf(timeOnly(istDate())); }
function candleIstMinutes(ts) { return minutesOf(timeOnly(istDate(new Date(ts)))); }
function completed(ts, minutes, nowMs) { return new Date(ts).getTime() + minutes * 60000 <= nowMs; }
function shiftDate(isoDate, days) { const d = new Date(isoDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return dateOnly(d); }
function intervalParts(tf) { return tf === '1h' ? ['hours', '1'] : ['minutes', String(TIMEFRAMES[tf])]; }
function executionRank(side, optionType) { return SEQUENCE[`${side}:${optionType}`] || 99; }
function fillPrice(side, market) {
  const bid = num(market?.bid_price);
  const ask = num(market?.ask_price);
  const ltp = num(market?.ltp);
  if (side === 'BUY' && Number.isFinite(ask) && ask > 0) return ask;
  if (side === 'SELL' && Number.isFinite(bid) && bid > 0) return bid;
  return ltp;
}

function heikinAshi(candles) {
  let prevOpen = null, prevClose = null;
  return candles.map(c => {
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = prevOpen === null ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    prevOpen = haOpen;
    prevClose = haClose;
    return { ...c, open: haOpen, high: haHigh, low: haLow, close: haClose };
  });
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

function regimePass(indicator, rule, threshold) {
  const r = rule || {};
  if (String(r.mode || 'ADX_RANGE') !== 'ADX_RANGE') return { pass: false, reason: 'UNSUPPORTED_REGIME_MODE' };
  const passAdx = indicator.adx < num(r.adx_less_than, threshold);
  const passPlus = r.adx_below_plus_di === false ? true : indicator.adx < indicator.plus_di;
  const passMinus = r.adx_below_minus_di === false ? true : indicator.adx < indicator.minus_di;
  return { pass: passAdx && passPlus && passMinus, reason: passAdx && passPlus && passMinus ? 'REGIME_CONFIRMED' : 'REGIME_NOT_CONFIRMED', checks: { adx_below_threshold: passAdx, adx_below_plus_di: passPlus, adx_below_minus_di: passMinus } };
}

async function broker(req) {
  const { rows } = await db.query('SELECT access_token, expires_at, status FROM broker_connections WHERE user_id = $1', [req.user.id]);
  const c = rows[0];
  if (!c || c.status !== 'CONNECTED' || !c.access_token) throw new Error('UPSTOX_NOT_CONNECTED');
  if (c.expires_at && new Date(c.expires_at).getTime() <= Date.now()) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
    throw new Error('UPSTOX_TOKEN_EXPIRED');
  }
  return c;
}

async function marketContext(connection, strategy, req) {
  const instrumentKey = UNDERLYINGS[strategy.underlying];
  const minutes = TIMEFRAMES[strategy.timeframe];
  if (!instrumentKey || !minutes) throw new Error('INVALID_STRATEGY_MARKET_CONFIGURATION');
  const now = Date.now();
  const ist = istDate();
  const toDate = dateOnly(ist);
  const lookbackDays = strategy.timeframe === '3m' || strategy.timeframe === '5m' ? 12 : strategy.timeframe === '15m' ? 20 : 45;
  const fromDate = shiftDate(toDate, -lookbackDays);
  const [unit, interval] = intervalParts(strategy.timeframe);
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token };
  const historicalUrl = 'https://api.upstox.com/v3/historical-candle/' + encodeURIComponent(instrumentKey) + '/' + unit + '/' + interval + '/' + encodeURIComponent(toDate) + '/' + encodeURIComponent(fromDate);
  const intradayUrl = 'https://api.upstox.com/v3/historical-candle/intraday/' + encodeURIComponent(instrumentKey) + '/' + unit + '/' + interval;
  const [hr, ir] = await Promise.all([fetch(historicalUrl, { headers }), fetch(intradayUrl, { headers })]);
  const hd = await hr.json().catch(() => ({}));
  const id = await ir.json().catch(() => ({}));
  if (hr.status === 401 || ir.status === 401) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
    throw new Error('UPSTOX_TOKEN_EXPIRED');
  }
  if (!hr.ok || hd.status !== 'success') throw new Error('UPSTOX_HISTORICAL_DATA_FAILED');
  if (!ir.ok || id.status !== 'success') throw new Error('UPSTOX_INTRADAY_DATA_FAILED');
  const merged = new Map();
  for (const c of parseCandles(hd.data?.candles || [])) merged.set(c.timestamp, c);
  for (const c of parseCandles(id.data?.candles || [])) merged.set(c.timestamp, c);
  const raw = [...merged.values()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const completedCandles = raw.filter(c => completed(c.timestamp, minutes, now));
  const basis = strategy.candle_type === 'HEIKIN_ASHI' ? heikinAshi(completedCandles) : completedCandles;
  const indicator = calculateIndicators(basis, Number(strategy.adx_period), Number(strategy.atr_period));
  if (!indicator) throw new Error('INSUFFICIENT_CANDLES');
  const lastRaw = completedCandles[completedCandles.length - 1];
  if (!lastRaw?.timestamp || !Number.isFinite(lastRaw.close)) throw new Error('MARKET_CONTEXT_INVALID');
  const candleAgeSeconds = Math.max(0, (now - new Date(lastRaw.timestamp).getTime()) / 1000);
  const timeframeSeconds = minutes * 60;
  // A completed candle may legitimately be older than one timeframe on a
  // non-trading interval, but it must never be older than two full candles
  // while the strategy is being evaluated during its trading window.
  const freshnessLimit = Math.max(120, timeframeSeconds * 2 + 30);
  if (!Number.isFinite(candleAgeSeconds) || candleAgeSeconds > freshnessLimit) throw new Error('MARKET_DATA_STALE');
  const spot = lastRaw.close;
  const upper = spot + Number(strategy.atr_multiplier) * indicator.atr;
  const lower = spot - Number(strategy.atr_multiplier) * indicator.atr;
  return { instrumentKey, minutes, completedCandles, indicator, spot, upper, lower, lastCandle: lastRaw, candleAgeSeconds, freshnessLimit };
}

async function riskGate(userId, campaign, chain, ctx) {
  const q = await db.query('SELECT * FROM risk_configs WHERE user_id=$1 LIMIT 1', [userId]);
  const cfg = q.rows[0] || { max_daily_loss: 50000, max_campaign_loss: 100000, max_position_quantity: 100000, max_rolls: 5, max_premium_exposure: 1000000, max_spread_pct: 10, stale_data_seconds: 1800, kill_switch: false };
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  add('Kill switch', !cfg.kill_switch, cfg.kill_switch ? 'ACTIVE' : 'inactive');
  const legsQ = await db.query('SELECT * FROM paper_campaign_legs WHERE campaign_id=$1 AND user_id=$2 AND status=$3', [campaign.id, userId, 'OPEN']);
  const open = legsQ.rows;
  const todayQ = await db.query("SELECT COALESCE(SUM(pnl),0) AS pnl FROM paper_campaign_legs WHERE user_id=$1 AND status='CLOSED' AND exit_at >= CURRENT_DATE", [userId]);
  const daily = Number(todayQ.rows[0]?.pnl || 0);
  const realized = Number(campaign.realized_pnl || 0);
  const openPnl = open.reduce((s,x)=>s+Number(x.pnl||0),0);
  const total = realized + openPnl;
  const rollQ = await db.query("SELECT COUNT(*)::int AS count FROM paper_decisions WHERE campaign_id=$1 AND user_id=$2 AND status='ROLL'", [campaign.id,userId]);
  const rolls = Number(rollQ.rows[0]?.count || 0);
  const grossPremium = open.reduce((s,x)=>s+Math.abs(Number(x.entry_price||0)*Number(x.quantity||0)),0);
  const maxQty = open.reduce((m,x)=>Math.max(m,Number(x.quantity||0)),0);
  const age = ctx?.lastCandle?.timestamp ? Math.max(0,(Date.now()-new Date(ctx.lastCandle.timestamp).getTime())/1000) : Infinity;
  add('Daily loss', daily > -Number(cfg.max_daily_loss), `daily ${daily.toFixed(2)} / floor -${Number(cfg.max_daily_loss).toFixed(2)}`);
  add('Campaign loss', total > -Number(cfg.max_campaign_loss), `total ${total.toFixed(2)} / floor -${Number(cfg.max_campaign_loss).toFixed(2)}`);
  add('Position quantity', maxQty <= Number(cfg.max_position_quantity), `max open qty ${maxQty} / limit ${Number(cfg.max_position_quantity)}`);
  // Roll count is enforced at the actual roll decision, not on ordinary entries.
  add('Roll count', rolls <= Number(cfg.max_rolls), `rolls ${rolls} / limit ${Number(cfg.max_rolls)}`);
  add('Premium exposure', grossPremium <= Number(cfg.max_premium_exposure), `gross ${grossPremium.toFixed(2)} / limit ${Number(cfg.max_premium_exposure).toFixed(2)}`);
  add('Data freshness', age <= Number(cfg.stale_data_seconds), `candle age ${Number.isFinite(age)?age.toFixed(0):'unknown'}s / limit ${Number(cfg.stale_data_seconds)}s`);
  const blocked = checks.some(x=>!x.pass);
  return { blocked, reason: blocked ? 'RISK_GATE_BLOCKED' : 'RISK_GATE_PASSED', checks, metrics: { daily_realized: daily, campaign_total: total, rolls, gross_premium_exposure: grossPremium, max_open_quantity: maxQty, candle_age_seconds: Number.isFinite(age)?age:null } };
}

async function projectedRiskGate(userId, campaign, selected, ctx) {
  const q = await db.query('SELECT * FROM risk_configs WHERE user_id=$1 LIMIT 1', [userId]);
  const cfg = q.rows[0] || { max_daily_loss: 50000, max_campaign_loss: 100000, max_position_quantity: 100000, max_rolls: 5, max_premium_exposure: 1000000, max_spread_pct: 10, stale_data_seconds: 1800, kill_switch: false };
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  add('Kill switch', !cfg.kill_switch, cfg.kill_switch ? 'ACTIVE' : 'inactive');
  const currentQ = await db.query('SELECT * FROM paper_campaign_legs WHERE campaign_id=$1 AND user_id=$2 AND status=$3', [campaign.id, userId, 'OPEN']);
  const open = currentQ.rows;
  const dailyQ = await db.query("SELECT COALESCE(SUM(pnl),0) AS pnl FROM paper_campaign_legs WHERE user_id=$1 AND status='CLOSED' AND exit_at >= CURRENT_DATE", [userId]);
  const daily = Number(dailyQ.rows[0]?.pnl || 0);
  const openPnl = open.reduce((s,x)=>s+Number(x.pnl||0),0);
  const total = Number(campaign.realized_pnl || 0) + openPnl;
  const newQty = selected.reduce((m,x)=>Math.max(m, Number(x.quantity||0)),0);
  const newExposure = selected.reduce((s,x)=>s+Math.abs(Number(x.entry_price||0)*Number(x.quantity||0)),0);
  const maxQty = Math.max(open.reduce((m,x)=>Math.max(m,Number(x.quantity||0)),0), newQty);
  const existingExposure = open.reduce((s,x)=>s+Math.abs(Number(x.entry_price||0)*Number(x.quantity||0)),0);
  const exposure = existingExposure + newExposure;
  const badSpread = selected.filter(x => Number.isFinite(Number(x.spreadPct)) && Number(x.spreadPct) > Number(cfg.max_spread_pct)).length;
  add('Daily loss', daily > -Number(cfg.max_daily_loss), `daily ${daily.toFixed(2)} / floor -${Number(cfg.max_daily_loss).toFixed(2)}`);
  add('Campaign loss', total > -Number(cfg.max_campaign_loss), `total ${total.toFixed(2)} / floor -${Number(cfg.max_campaign_loss).toFixed(2)}`);
  add('Projected position quantity', maxQty <= Number(cfg.max_position_quantity), `projected max qty ${maxQty} / limit ${Number(cfg.max_position_quantity)}`);
  add('Projected premium exposure', exposure <= Number(cfg.max_premium_exposure), `projected gross ${exposure.toFixed(2)} / limit ${Number(cfg.max_premium_exposure).toFixed(2)}`);
  add('Global spread limit', badSpread === 0, badSpread ? `${badSpread} selected leg(s) exceed global spread limit ${Number(cfg.max_spread_pct)}%` : `all selected legs within ${Number(cfg.max_spread_pct)}%`);
  const age = ctx?.lastCandle?.timestamp ? Math.max(0,(Date.now()-new Date(ctx.lastCandle.timestamp).getTime())/1000) : Infinity;
  add('Data freshness', age <= Number(cfg.stale_data_seconds), `candle age ${Number.isFinite(age)?age.toFixed(0):'unknown'}s / limit ${Number(cfg.stale_data_seconds)}s`);
  const blocked = checks.some(x=>!x.pass);
  return { blocked, reason: blocked ? 'PROJECTED_RISK_BLOCKED' : 'PROJECTED_RISK_PASSED', checks, metrics: { projected_max_quantity:maxQty, projected_premium_exposure:exposure, selected_legs:selected.length, candle_age_seconds:Number.isFinite(age)?age:null } };
}

async function optionChain(connection, strategy, userId) {
  const instrumentKey = UNDERLYINGS[strategy.underlying];
  const expiryRequest = strategy.option_expiry || 'current_week';
  if (!ALLOWED_EXPIRIES.has(expiryRequest) && !/^\d{4}-\d{2}-\d{2}$/.test(expiryRequest)) throw new Error('INVALID_EXPIRY');
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token };

  // Upstox Option Contracts accepts relative expiry keywords, while the
  // Put/Call Option Chain requires the resolved YYYY-MM-DD expiry. Resolve
  // the configured expiry once, then use that exact date for both data sets.
  const contractResponse = await fetch('https://api.upstox.com/v2/option/contract?instrument_key=' + encodeURIComponent(instrumentKey) + '&expiry_date=' + encodeURIComponent(expiryRequest), { headers });
  const contractData = await contractResponse.json().catch(() => ({}));
  if (contractResponse.status === 401) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [userId]);
    throw new Error('UPSTOX_TOKEN_EXPIRED');
  }
  if (!contractResponse.ok || contractData.status !== 'success' || !Array.isArray(contractData.data) || !contractData.data.length) throw new Error('UPSTOX_OPTION_CONTRACTS_FAILED');
  const contracts = contractData.data;
  const expiry = contracts.map(x => x.expiry).filter(Boolean).sort()[0];
  if (!expiry) throw new Error('UPSTOX_EXPIRY_RESOLUTION_FAILED');
  const chainResponse = await fetch('https://api.upstox.com/v2/option/chain?instrument_key=' + encodeURIComponent(instrumentKey) + '&expiry_date=' + encodeURIComponent(expiry), { headers });
  const chain = await chainResponse.json().catch(() => ({}));
  if (chainResponse.status === 401) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [userId]);
    throw new Error('UPSTOX_TOKEN_EXPIRED');
  }
  if (!chainResponse.ok || chain.status !== 'success' || !Array.isArray(chain.data) || !chain.data.length) throw new Error('UPSTOX_OPTION_CHAIN_FAILED');
  const metaByKey = new Map(contracts.map(x => [x.instrument_key, x]));
  return { rows: chain.data, expiry, expiry_request: expiryRequest, metaByKey, spot: num(chain.data[0]?.underlying_spot_price) };
}

function selectLeg(chain, strategy, leg) {
  const optionType = leg.option_type === 'PE' ? 'PE' : 'CE';
  const method = leg.selection_method || 'ATM';
  const distanceMode = leg.distance_mode || 'ATM';
  const spot = chain.spot;
  const minOi = Math.max(0, num(leg.min_oi, 0));
  const minVolume = Math.max(0, num(leg.min_volume, 0));
  const maxSpreadPct = Math.max(0, num(leg.max_spread_pct, 10));
  const targetPremium = num(leg.target_premium);
  const premiumTolerance = Math.max(0, num(leg.premium_tolerance, 5));
  const targetDelta = num(leg.target_delta);
  const deltaTolerance = Math.max(0, num(leg.delta_tolerance, 0.1));
  const customStrike = num(leg.custom_strike);
  const strikeOffset = Math.max(0, Number.parseInt(leg.strike_offset, 10) || 0);
  const candidates = [];
  for (const row of chain.rows) {
    const option = optionType === 'CE' ? row.call_options : row.put_options;
    if (!option?.instrument_key) continue;
    const market = option.market_data || {};
    const greeks = option.option_greeks || {};
    const strike = num(row.strike_price);
    const ltp = num(market.ltp);
    const bid = num(market.bid_price);
    const ask = num(market.ask_price);
    const oi = num(market.oi, 0);
    const volume = num(market.volume, 0);
    const delta = num(greeks.delta);
    if (!Number.isFinite(strike)) continue;
    const spread = Number.isFinite(bid) && Number.isFinite(ask) ? Math.max(0, ask - bid) : NaN;
    const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid + ask > 0 ? (bid + ask) / 2 : NaN;
    const spreadPct = Number.isFinite(spread) && Number.isFinite(mid) && mid > 0 ? spread / mid * 100 : NaN;
    const distance = Math.abs(strike - spot);
    const distanceClass = strike === spot ? 'ATM' : optionType === 'CE' ? (strike < spot ? 'ITM' : 'OTM') : (strike > spot ? 'ITM' : 'OTM');
    if (oi < minOi || volume < minVolume) continue;
    if (maxSpreadPct > 0 && (!Number.isFinite(spreadPct) || spreadPct > maxSpreadPct)) continue;
    if (method !== 'ATM' && method !== 'CUSTOM_STRIKE' && distanceMode !== 'ATM' && distanceClass !== distanceMode) continue;
    if (method === 'CUSTOM_STRIKE' && (!Number.isFinite(customStrike) || strike !== customStrike)) continue;
    if (method === 'PREMIUM' && (!Number.isFinite(targetPremium) || !Number.isFinite(ltp) || ltp < targetPremium - premiumTolerance || ltp > targetPremium + premiumTolerance)) continue;
    if (method === 'DELTA' && (!Number.isFinite(targetDelta) || !Number.isFinite(delta) || Math.abs(delta) < targetDelta - deltaTolerance || Math.abs(delta) > targetDelta + deltaTolerance)) continue;
    candidates.push({ row, option, market, greeks, strike, ltp, bid, ask, oi, volume, delta, spreadPct, distance, distanceClass, contract: chain.metaByKey.get(option.instrument_key) || null });
  }
  if (!candidates.length) return { ok: false, error: 'OPTION_SELECTION_FAILED', reason: 'NO_ELIGIBLE_CONTRACT', leg_id: leg.id, option_type: optionType, selection_method: method };
  let pool = candidates;
  let targetStrike = spot;
  if (method === 'ATM') {
    const d = Math.min(...pool.map(x => x.distance));
    pool = pool.filter(x => x.distance === d);
  } else if (method === 'STRIKE_OFFSET') {
    const sorted = [...pool].sort((a, b) => a.strike - b.strike || a.option.instrument_key.localeCompare(b.option.instrument_key));
    const atmIndex = sorted.reduce((best, c, i) => Math.abs(sorted[i].strike - spot) < Math.abs(sorted[best].strike - spot) ? i : best, 0);
    const direction = distanceMode === 'ITM' ? (optionType === 'CE' ? -1 : 1) : (distanceMode === 'OTM' ? (optionType === 'CE' ? 1 : -1) : 0);
    const targetIndex = atmIndex + direction * strikeOffset;
    if (targetIndex < 0 || targetIndex >= sorted.length) return { ok: false, error: 'OPTION_SELECTION_FAILED', reason: 'STRIKE_OFFSET_OUT_OF_RANGE', leg_id: leg.id };
    targetStrike = sorted[targetIndex].strike;
    pool = pool.filter(x => x.strike === targetStrike);
  } else if (method === 'CUSTOM_STRIKE') {
    targetStrike = customStrike;
  }
  pool.sort((a, b) => {
    if (method === 'PREMIUM') { const d = Math.abs(a.ltp - targetPremium) - Math.abs(b.ltp - targetPremium); if (d) return d; }
    if (method === 'DELTA') { const d = Math.abs(Math.abs(a.delta) - targetDelta) - Math.abs(Math.abs(b.delta) - targetDelta); if (d) return d; }
    const d = Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike); if (d) return d;
    const sa = Number.isFinite(a.spreadPct) ? a.spreadPct : Infinity;
    const sb = Number.isFinite(b.spreadPct) ? b.spreadPct : Infinity;
    if (sa !== sb) return sa - sb;
    if (a.oi !== b.oi) return b.oi - a.oi;
    return a.option.instrument_key.localeCompare(b.option.instrument_key);
  });
  const selected = pool[0];
  const contract = selected.contract || {};
  const lotSize = Number(contract.lot_size);
  if (!Number.isFinite(lotSize) || lotSize <= 0) return { ok: false, error: 'OPTION_SELECTION_FAILED', reason: 'MISSING_LOT_SIZE', leg_id: leg.id };
  const lots = Math.max(1, Number.parseInt(leg.lots, 10) || 1);
  const quantityPerLot = Math.max(1, Number.parseInt(leg.quantity, 10) || 1);
  return {
    ok: true,
    leg_id: String(leg.id),
    role: leg.role === 'HEDGE' ? 'HEDGE' : 'PRIMARY',
    side: leg.side === 'BUY' ? 'BUY' : 'SELL',
    option_type: optionType,
    execution_rank: executionRank(leg.side === 'BUY' ? 'BUY' : 'SELL', optionType),
    expiry: chain.expiry,
    strike: selected.strike,
    instrument_key: selected.option.instrument_key,
    trading_symbol: contract.trading_symbol || null,
    lot_size: lotSize,
    lots,
    quantity: lotSize * lots * quantityPerLot,
    market: selected.market,
    entry_price: fillPrice(leg.side === 'BUY' ? 'BUY' : 'SELL', selected.market),
    ltp: selected.ltp,
    contract
  };
}

async function markOpenLegs(userId, campaignId, chain) {
  const q = await db.query('SELECT * FROM paper_campaign_legs WHERE user_id = $1 AND campaign_id = $2 AND status = $3 ORDER BY execution_rank', [userId, campaignId, 'OPEN']);
  let mtm = 0;
  const marked = [];
  for (const leg of q.rows) {
    const row = chain.rows.find(x => (x.call_options?.instrument_key === leg.instrument_key) || (x.put_options?.instrument_key === leg.instrument_key));
    const market = row ? (row.call_options?.instrument_key === leg.instrument_key ? row.call_options.market_data : row.put_options.market_data) : null;
    const price = num(market?.ltp);
    if (!Number.isFinite(price) || price < 0) throw new Error('PAPER_MARKET_DATA_MISSING');
    const pnl = (leg.side === 'BUY' ? 1 : -1) * (price - Number(leg.entry_price)) * Number(leg.quantity);
    mtm += pnl;
    await db.query('UPDATE paper_campaign_legs SET current_price=$1, pnl=$2, last_mark_at=now() WHERE id=$3 AND user_id=$4', [price, pnl, leg.id, userId]);
    marked.push({ id: leg.id, leg_id: leg.leg_id, side: leg.side, option_type: leg.option_type, strike: Number(leg.strike), quantity: Number(leg.quantity), entry_price: Number(leg.entry_price), current_price: price, pnl });
  }
  return { mtm, legs: marked };
}

function closeRank(leg) {
  // Roll/exit safety sequence is deliberately independent of entry rank:
  // 1) primary CE, 2) primary PE, 3) hedge CE, 4) hedge PE.
  const role = leg.role === 'HEDGE' ? 1 : 0;
  const type = leg.option_type === 'CE' ? 0 : 1;
  return role * 2 + type + 1;
}

async function closeOpenLegs(userId, campaign, chain, reason, scope = 'ALL') {
  const scopeClause = scope === 'SELL_ONLY' ? " AND side = 'SELL'" : '';
  const q = await db.query(`SELECT * FROM paper_campaign_legs WHERE user_id = $1 AND campaign_id = $2 AND status = $3${scopeClause} ORDER BY execution_rank`, [userId, campaign.id, 'OPEN']);
  const ordered = [...q.rows].sort((a, b) => closeRank(a) - closeRank(b) || Number(a.execution_rank) - Number(b.execution_rank));
  let realized = 0;
  const closed = [];
  const updates = [];
  // Resolve every exit price before mutating any leg. Then commit all leg exits atomically.
  for (const leg of ordered) {
    const row = chain.rows.find(x => (x.call_options?.instrument_key === leg.instrument_key) || (x.put_options?.instrument_key === leg.instrument_key));
    const market = row ? (row.call_options?.instrument_key === leg.instrument_key ? row.call_options.market_data : row.put_options.market_data) : null;
    if (!market) throw new Error('PAPER_EXIT_MARKET_DATA_MISSING');
    const price = fillPrice(leg.side === 'BUY' ? 'SELL' : 'BUY', market);
    if (!Number.isFinite(price) || price < 0) throw new Error('PAPER_EXIT_PRICE_UNAVAILABLE');
    const pnl = (leg.side === 'BUY' ? 1 : -1) * (price - Number(leg.entry_price)) * Number(leg.quantity);
    realized += pnl;
    updates.push({ leg, price, pnl });
    closed.push({ leg_id: leg.leg_id, side: leg.side, option_type: leg.option_type, strike: Number(leg.strike), entry_price: Number(leg.entry_price), exit_price: price, quantity: Number(leg.quantity), pnl });
  }
  if (updates.length) {
    await db.transaction(updates.map(({ leg, price, pnl }) => ({
      sql: 'UPDATE paper_campaign_legs SET status=$1, exit_price=$2, current_price=$2, pnl=$3, exit_at=now(), last_mark_at=now(), metadata=metadata || $4::jsonb WHERE id=$5 AND user_id=$6 AND status=$7',
      params: ['CLOSED', price, pnl, JSON.stringify({ exit_reason: reason }), leg.id, userId, 'OPEN']
    })));
  }
  return { realized, closed };
}

async function recordDecision(userId, campaign, strategy, ctx, status, reason, regime, signal, details) {
  await db.query('INSERT INTO paper_decisions (user_id,campaign_id,strategy_id,strategy_version,candle_at,status,reason,regime,indicators,signal,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
    userId, campaign.id, strategy.id, Number(strategy.version || 1), ctx?.lastCandle?.timestamp || null, status, reason, regime || null,
    JSON.stringify(ctx ? { adx: ctx.indicator.adx, plus_di: ctx.indicator.plus_di, minus_di: ctx.indicator.minus_di, atr: ctx.indicator.atr, spot: ctx.spot, atr_upper: ctx.upper, atr_lower: ctx.lower } : {}),
    JSON.stringify(signal || {}), JSON.stringify(details || {})
  ]);
  await db.query('UPDATE paper_campaigns SET updated_at=now(), last_cycle_at=now(), last_status=$1, last_reason=$2 WHERE id=$3 AND user_id=$4', [status, reason, campaign.id, userId]);
}

async function state(userId, campaignId) {
  const c = campaignId ? await db.query('SELECT * FROM paper_campaigns WHERE id=$1 AND user_id=$2 LIMIT 1', [campaignId, userId]) : await db.query("SELECT * FROM paper_campaigns WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1", [userId]);
  const campaign = c.rows[0];
  if (!campaign) return { campaign: null, legs: [], decisions: [] };
  const legs = await db.query('SELECT * FROM paper_campaign_legs WHERE campaign_id=$1 AND user_id=$2 ORDER BY entry_at DESC, execution_rank', [campaign.id, userId]);
  const decisions = await db.query('SELECT * FROM paper_decisions WHERE campaign_id=$1 AND user_id=$2 ORDER BY cycle_at DESC LIMIT 10', [campaign.id, userId]);
  const open = legs.rows.filter(x => x.status === 'OPEN');
  const mtm = open.reduce((s, x) => s + Number(x.pnl || 0), 0);
  const realized = Number(campaign.realized_pnl || 0);
  return {
    campaign: { ...campaign, entry_spot: num(campaign.entry_spot, null), corridor_upper: num(campaign.corridor_upper, null), corridor_lower: num(campaign.corridor_lower, null), realized_pnl: realized, mtm_pnl: mtm, total_pnl: realized + mtm },
    legs: legs.rows.map(x => ({ ...x, strike: Number(x.strike), quantity: Number(x.quantity), entry_price: Number(x.entry_price), exit_price: x.exit_price == null ? null : Number(x.exit_price), current_price: x.current_price == null ? null : Number(x.current_price), pnl: Number(x.pnl || 0) })),
    decisions: decisions.rows
  };
}

async function cycle(req, res, campaign) {
  const userId = req.user.id;
  const s = await db.query('SELECT * FROM strategy_configs WHERE id=$1 AND user_id=$2 LIMIT 1', [campaign.strategy_id, userId]);
  const strategyBase = s.rows[0];
  if (!strategyBase) return res.status(404).json({ error: 'STRATEGY_NOT_FOUND' });
  const versionQ = await db.query('SELECT version_number, config FROM strategy_versions WHERE strategy_id=$1 AND user_id=$2 AND version_number=$3 LIMIT 1', [campaign.strategy_id, userId, Number(campaign.strategy_version || strategyBase.version || 1)]);
  const pinned = versionQ.rows[0];
  if (!pinned) return res.status(409).json({ error: 'STRATEGY_VERSION_NOT_FOUND', version: Number(campaign.strategy_version || strategyBase.version || 1) });
  const versionConfig = pinned.config && typeof pinned.config === 'object' ? pinned.config : {};
  const strategy = { ...strategyBase, ...versionConfig, id: strategyBase.id, version: Number(pinned.version_number), leg_config: versionConfig.legs || strategyBase.leg_config || [] };
  const strategyObj = { ...strategy, adx_threshold: Number(strategy.adx_threshold), atr_multiplier: Number(strategy.atr_multiplier), regime_rule: strategy.regime_rule || {}, leg_config: strategy.leg_config || [] };
  const connection = await broker(req);
  const ctx = await marketContext(connection, strategyObj, req);
  const chain = await optionChain(connection, strategyObj, req.user.id);
  if (!Number.isFinite(ctx.spot) || !ctx.lastCandle?.timestamp || !Number.isFinite(chain.spot)) {
    throw new Error('MARKET_CONTEXT_INVALID');
  }
  const currentMinutes = nowIstMinutes();
  const start = minutesOf(strategyObj.start_time || '09:45');
  const squareOff = minutesOf(strategyObj.square_off || '15:15');
  const openQ = await db.query('SELECT * FROM paper_campaign_legs WHERE user_id=$1 AND campaign_id=$2 AND status=$3 ORDER BY execution_rank', [userId, campaign.id, 'OPEN']);

  if (currentMinutes >= squareOff) {
    if (openQ.rows.length) {
      const result = await closeOpenLegs(userId, campaign, chain, 'SQUARE_OFF');
      await db.query('UPDATE paper_campaigns SET status=$1, closed_at=now(), realized_pnl=COALESCE(realized_pnl,0)+$2, entry_spot=null, corridor_upper=null, corridor_lower=null, active_expiry=null, updated_at=now() WHERE id=$3 AND user_id=$4', ['CLOSED', result.realized, campaign.id, userId]);
      await recordDecision(userId, campaign, strategyObj, ctx, 'SQUARE_OFF', 'SQUARE_OFF_TIME_REACHED', 'N/A', { action: 'CLOSE' }, { closed_legs: result.closed, realized_pnl: result.realized });
      return res.json({ ...(await state(userId, campaign.id)), cycle: { action: 'CLOSE', reason: 'SQUARE_OFF_TIME_REACHED', closed: result.closed } });
    }
    await db.query('UPDATE paper_campaigns SET status=$1, closed_at=COALESCE(closed_at,now()), updated_at=now() WHERE id=$2 AND user_id=$3', ['CLOSED', campaign.id, userId]);
    await recordDecision(userId, campaign, strategyObj, ctx, 'CLOSED', 'SQUARE_OFF_TIME_REACHED_NO_POSITION', 'N/A', { action: 'NONE' }, {});
    return res.json({ ...(await state(userId, campaign.id)), cycle: { action: 'NONE', reason: 'SQUARE_OFF_TIME_REACHED_NO_POSITION' } });
  }

  // Risk never prevents an emergency square-off. It only gates new entries/rolls.
  const risk = await riskGate(userId, campaign, chain, ctx);
  if (risk.blocked) {
    await recordDecision(userId, campaign, strategyObj, ctx, 'RISK_BLOCKED', risk.reason, 'RISK_OVERRIDE', { action: 'BLOCK' }, { risk_checks: risk.checks, risk_metrics: risk.metrics });
    return res.status(409).json({ ...(await state(userId, campaign.id)), cycle: { action: 'BLOCK', reason: risk.reason, risk: risk.metrics }, broker_orders_sent: false });
  }

  const candleMinutes = candleIstMinutes(ctx.lastCandle.timestamp);
  if (candleMinutes < start) {
    await recordDecision(userId, campaign, strategyObj, ctx, 'WAITING', 'WAITING_FOR_POST_START_COMPLETED_CANDLE', 'PRE_START', { action: 'NONE' }, { start_time: strategyObj.start_time, completed_candle: ctx.lastCandle.timestamp });
    return res.json({ ...(await state(userId, campaign.id)), cycle: { action: 'NONE', reason: 'WAITING_FOR_POST_START_COMPLETED_CANDLE' } });
  }

  if (openQ.rows.length) {
    const expected = (Array.isArray(strategyObj.leg_config) ? strategyObj.leg_config : []).filter(x => x.enabled !== false);
    const activeIds = new Set(openQ.rows.map(x => String(x.leg_id)));
    const expectedIds = new Set(expected.map(x => String(x.id)));
    const structureMismatch = expected.length !== openQ.rows.length || [...expectedIds].some(id => !activeIds.has(id));
    if (structureMismatch) {
      await recordDecision(userId, campaign, strategyObj, ctx, 'BLOCKED', 'STRUCTURE_INTEGRITY_MISMATCH', 'ACTIVE_POSITION', { action: 'BLOCK' }, { expected_leg_count: expected.length, active_leg_count: openQ.rows.length, expected_leg_ids: [...expectedIds], active_leg_ids: [...activeIds], note: 'No automatic repair or additional leg is created.' });
      return res.status(409).json({ ...(await state(userId, campaign.id)), cycle: { action: 'BLOCK', reason: 'STRUCTURE_INTEGRITY_MISMATCH' }, broker_orders_sent: false });
    }
    const marks = await markOpenLegs(userId, campaign.id, chain);
    const entrySpot = num(campaign.entry_spot);
    const upper = num(campaign.corridor_upper);
    const lower = num(campaign.corridor_lower);
    const breach = Number.isFinite(entrySpot) && Number.isFinite(upper) && Number.isFinite(lower) && (ctx.lastCandle.close > upper || ctx.lastCandle.close < lower);
    const rollConfirmations = Math.max(1, Number(strategyObj.confirmation_candles || 1));
    const recentRollCandles = ctx.completedCandles.slice(-rollConfirmations);
    const confirmedBreach = breach && recentRollCandles.length === rollConfirmations && recentRollCandles.every(c => c.close > upper || c.close < lower);
    if (confirmedBreach && strategyObj.roll_mode === 'CLOSED_CANDLE_OUTSIDE_CORRIDOR') {
      // A roll is a complete structure replacement. Never leave an old hedge
      // orphaned while replacing the short legs. Also guard against repeating
      // the same roll on every 30-second poll of the same completed candle.
      const priorRoll = await db.query('SELECT id FROM paper_decisions WHERE campaign_id=$1 AND user_id=$2 AND status=$3 AND candle_at=$4 LIMIT 1', [campaign.id, userId, 'ROLL', ctx.lastCandle.timestamp]);
      if (priorRoll.rows.length) {
        await recordDecision(userId, campaign, strategyObj, ctx, 'ACTIVE', 'ROLL_ALREADY_PROCESSED_FOR_CANDLE', 'ACTIVE_POSITION', { action: 'HOLD' }, { mtm_pnl: marks.mtm, confirmed_breach: true });
        return res.json({ ...(await state(userId, campaign.id)), cycle: { action: 'HOLD', reason: 'ROLL_ALREADY_PROCESSED_FOR_CANDLE' } });
      }
      const result = await closeOpenLegs(userId, campaign, chain, 'CORRIDOR_BREACH_ROLL', 'ALL');
      await db.query('UPDATE paper_campaigns SET realized_pnl=COALESCE(realized_pnl,0)+$1, entry_spot=null, corridor_upper=null, corridor_lower=null, active_expiry=null, updated_at=now() WHERE id=$2 AND user_id=$3', [result.realized, campaign.id, userId]);
      await recordDecision(userId, campaign, strategyObj, ctx, 'ROLL', 'CLOSED_CANDLE_OUTSIDE_CORRIDOR', 'ACTIVE_POSITION', { action: 'ROLL' }, { closed_legs: result.closed, mtm_before_roll: marks.mtm, realized_on_roll: result.realized, note: 'Complete structure closed before new contracts were resolved.' });
      return await openNewStructure(req, res, campaign, strategyObj, connection, ctx, chain, 'ROLL_REENTRY');
    }
    const holdReason = breach && !confirmedBreach ? 'CORRIDOR_BREACH_NOT_CONFIRMED' : breach ? 'CORRIDOR_BREACH_DETECTED_BUT_ROLL_DISABLED' : 'POSITION_ACTIVE';
    await recordDecision(userId, campaign, strategyObj, ctx, 'ACTIVE', holdReason, 'ACTIVE_POSITION', { action: 'HOLD' }, { mtm_pnl: marks.mtm, corridor_breach: breach, confirmed_breach: confirmedBreach, required_confirmations: rollConfirmations });
    return res.json({ ...(await state(userId, campaign.id)), cycle: { action: 'HOLD', reason: holdReason } });
  }

  const basis = strategyObj.candle_type === 'HEIKIN_ASHI' ? heikinAshi(ctx.completedCandles) : ctx.completedCandles;
  const confirmations = Math.max(1, Number(strategyObj.confirmation_candles || 1));
  const checks = [];
  for (let i = 0; i < confirmations; i++) {
    const end = basis.length - i;
    const slice = basis.slice(0, end);
    const ind = calculateIndicators(slice, Number(strategyObj.adx_period), Number(strategyObj.atr_period));
    if (!ind) break;
    checks.push(regimePass(ind, strategyObj.regime_rule, strategyObj.adx_threshold));
  }
  const regimeOk = checks.length === confirmations && checks.every(x => x.pass);
  if (!regimeOk) {
    await recordDecision(userId, campaign, strategyObj, ctx, 'NO_SIGNAL', 'REGIME_NOT_CONFIRMED', 'NOT_CONFIRMED', { action: 'NONE' }, { confirmation_checks: checks, required: confirmations });
    return res.json({ ...(await state(userId, campaign.id)), cycle: { action: 'NONE', reason: 'REGIME_NOT_CONFIRMED' } });
  }
  return await openNewStructure(req, res, campaign, strategyObj, connection, ctx, chain, 'ENTRY_SIGNAL');
}

async function openNewStructure(req, res, campaign, strategy, connection, ctx, chain, trigger) {
  const userId = req.user.id;
  // Both a fresh entry and a roll resolve the complete configured structure.
  // A roll has already closed every old leg, including hedges, so there is no
  // retained contract that could become orphaned or mismatched with the new ATM.
  const rolling = trigger === 'ROLL_REENTRY';
  const configured = Array.isArray(strategy.leg_config)
    ? strategy.leg_config.filter(x => x.enabled !== false)
    : [];
  if (!configured.length) return res.status(422).json({ error: 'NO_ENABLED_STRATEGY_LEGS' });
  const selected = [];
  for (const leg of configured) {
    const result = selectLeg(chain, strategy, leg);
    if (!result.ok) {
      await recordDecision(userId, campaign, strategy, ctx, 'BLOCKED', result.reason || 'OPTION_SELECTION_FAILED', 'CONFIRMED', { action: 'BLOCK' }, { leg_id: leg.id, selection_error: result });
      return res.status(422).json({ ...(await state(userId, campaign.id)), cycle: { action: 'BLOCK', reason: 'OPTION_SELECTION_FAILED', selection: result } });
    }
    selected.push(result);
  }
  selected.sort((a, b) => a.execution_rank - b.execution_rank);
  const projectedRisk = await projectedRiskGate(userId, campaign, selected, ctx);
  if (projectedRisk.blocked) {
    await recordDecision(userId, campaign, strategy, ctx, 'BLOCKED', projectedRisk.reason, 'RISK_OVERRIDE', { action: 'BLOCK' }, { risk_checks: projectedRisk.checks, risk_metrics: projectedRisk.metrics, trigger });
    return res.status(422).json({ ...(await state(userId, campaign.id)), cycle: { action: 'BLOCK', reason: projectedRisk.reason, risk: projectedRisk.metrics }, broker_orders_sent: false });
  }
  const seen = new Set();
  for (const leg of selected) {
    if (seen.has(leg.instrument_key)) {
      await recordDecision(userId, campaign, strategy, ctx, 'BLOCKED', 'DUPLICATE_INSTRUMENT', 'CONFIRMED', { action: 'BLOCK' }, { instrument_key: leg.instrument_key });
      return res.status(422).json({ ...(await state(userId, campaign.id)), cycle: { action: 'BLOCK', reason: 'DUPLICATE_INSTRUMENT' } });
    }
    seen.add(leg.instrument_key);
  }
  if (selected.some(x => !Number.isFinite(x.entry_price) || x.entry_price < 0)) {
    await recordDecision(userId, campaign, strategy, ctx, 'BLOCKED', 'INVALID_SIMULATED_FILL_PRICE', 'CONFIRMED', { action: 'BLOCK' }, { selected });
    return res.status(422).json({ ...(await state(userId, campaign.id)), cycle: { action: 'BLOCK', reason: 'INVALID_SIMULATED_FILL_PRICE' } });
  }

  const cycleId = crypto.randomUUID();
  // All contracts are resolved and validated before any simulated fill is
  // recorded. The transaction guarantees that a database failure cannot leave
  // a partially-created multi-leg structure.
  // Initial and roll entry order is always BUY CE -> BUY PE -> SELL CE -> SELL PE.
  const statements = selected.map(leg => ({
    sql: 'INSERT INTO paper_campaign_legs (user_id,campaign_id,strategy_id,strategy_version,cycle_id,leg_id,role,side,option_type,execution_rank,expiry,strike,instrument_key,trading_symbol,lot_size,lots,quantity,entry_price,current_price,pnl,status,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,0,$19,$20) RETURNING id',
    params: [userId, campaign.id, strategy.id, Number(strategy.version || 1), cycleId, leg.leg_id, leg.role, leg.side, leg.option_type, leg.execution_rank, leg.expiry, leg.strike, leg.instrument_key, leg.trading_symbol, leg.lot_size, leg.lots, leg.quantity, leg.entry_price, 'OPEN', JSON.stringify({ trigger, simulated: true, fill_basis: leg.side === 'BUY' ? 'ASK_OR_LTP' : 'BID_OR_LTP' })]
  }));
  await db.transaction(statements);
  const upper = ctx.spot + Number(strategy.atr_multiplier) * ctx.indicator.atr;
  const lower = ctx.spot - Number(strategy.atr_multiplier) * ctx.indicator.atr;
  await db.query('UPDATE paper_campaigns SET strategy_version=$1, entry_spot=$2, corridor_upper=$3, corridor_lower=$4, active_expiry=$5, updated_at=now(), last_cycle_at=now(), last_status=$6, last_reason=$7 WHERE id=$8 AND user_id=$9', [Number(strategy.version || 1), ctx.spot, upper, lower, chain.expiry, 'ENTRY', trigger, campaign.id, userId]);
  await recordDecision(userId, campaign, strategy, ctx, 'ENTRY', trigger, 'CONFIRMED', { action: 'OPEN', execution_order: selected.map(x => `${x.side} ${x.option_type}`) }, { cycle_id: cycleId, legs: selected, entry_spot: ctx.spot, corridor_upper: upper, corridor_lower: lower, note: 'Simulated fills only; no broker orders.' });
  return res.json({ ...(await state(userId, campaign.id)), cycle: { action: 'OPEN', reason: trigger, execution_order: selected.map(x => ({ side: x.side, option_type: x.option_type, rank: x.execution_rank, strike: x.strike, entry_price: x.entry_price })), broker_orders_sent: false } });
}

export default async function(req, res) {
  const userId = req.user.id;
  let campaignId = req.query?.campaign_id || req.body?.campaign_id || null;
  if (req.method === 'GET') return res.json(await state(userId, campaignId));

  const action = String(req.body?.action || 'CYCLE').toUpperCase();
  const q = campaignId ? await db.query('SELECT * FROM paper_campaigns WHERE id=$1 AND user_id=$2 LIMIT 1', [campaignId, userId]) : await db.query("SELECT * FROM paper_campaigns WHERE user_id=$1 AND status='RUNNING' ORDER BY started_at DESC LIMIT 1", [userId]);
  const campaign = q.rows[0];
  if (!campaign) return res.status(404).json({ error: 'PAPER_CAMPAIGN_NOT_RUNNING' });

  if (action === 'KILL' || action === 'STOP') {
    const connection = await broker(req);
    const strategyQ = await db.query('SELECT * FROM strategy_configs WHERE id=$1 AND user_id=$2 LIMIT 1', [campaign.strategy_id, userId]);
    if (!strategyQ.rows[0]) return res.status(404).json({ error: 'STRATEGY_NOT_FOUND' });
    const versionQ = await db.query('SELECT version_number, config FROM strategy_versions WHERE strategy_id=$1 AND user_id=$2 AND version_number=$3 LIMIT 1', [campaign.strategy_id, userId, Number(campaign.strategy_version || strategyQ.rows[0].version || 1)]);
    if (!versionQ.rows[0]) return res.status(409).json({ error: 'STRATEGY_VERSION_NOT_FOUND' });
    const pinned = versionQ.rows[0].config && typeof versionQ.rows[0].config === 'object' ? versionQ.rows[0].config : {};
    const stopStrategy = { ...strategyQ.rows[0], ...pinned, option_expiry: pinned.option_expiry || strategyQ.rows[0].option_expiry };
    const chain = await optionChain(connection, stopStrategy, userId);
    const isKill = action === 'KILL';
    const closeReason = isKill ? 'RISK_KILL_SWITCH' : 'USER_STOP';
    const result = await closeOpenLegs(userId, campaign, chain, closeReason);
    await db.query('UPDATE paper_campaigns SET status=$1, closed_at=now(), realized_pnl=COALESCE(realized_pnl,0)+$2, updated_at=now(), last_status=$3, last_reason=$4 WHERE id=$5 AND user_id=$6', ['STOPPED', result.realized, 'STOPPED', closeReason, campaign.id, userId]);
    if (isKill) await db.query('UPDATE risk_configs SET kill_switch=true, updated_at=now() WHERE user_id=$1', [userId]);
    return res.json({ ...(await state(userId, campaign.id)), cycle: { action: isKill ? 'KILL' : 'STOP', reason: closeReason, closed: result.closed, broker_orders_sent: false } });
  }

  if (campaign.status !== 'RUNNING') return res.status(409).json({ ...(await state(userId, campaign.id)), error: 'PAPER_CAMPAIGN_NOT_RUNNING' });
  try {
    return await cycle(req, res, campaign);
  } catch (error) {
    const message = String(error?.message || 'PAPER_ENGINE_ERROR');
    await db.query('UPDATE paper_campaigns SET last_cycle_at=now(), last_status=$1, last_reason=$2, updated_at=now() WHERE id=$3 AND user_id=$4', ['ERROR', message, campaign.id, userId]);
    return res.status(502).json({ ...(await state(userId, campaign.id)), error: message, broker_orders_sent: false });
  }
}