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
const METHODS = new Set(['ATM', 'STRIKE_OFFSET', 'PREMIUM', 'DELTA', 'CUSTOM_STRIKE']);
const TYPES = new Set(['CE', 'PE']);
const DISTANCES = new Set(['ATM', 'ITM', 'OTM']);

// Canonical multi-leg execution priority. This is deliberately fixed so that
// a future execution layer cannot accidentally send short legs before the
// protective long legs are established.
const EXECUTION_SEQUENCE = [
  { side: 'BUY', option_type: 'CE', rank: 1, label: 'BUY CE' },
  { side: 'BUY', option_type: 'PE', rank: 2, label: 'BUY PE' },
  { side: 'SELL', option_type: 'CE', rank: 3, label: 'SELL CE' },
  { side: 'SELL', option_type: 'PE', rank: 4, label: 'SELL PE' }
];

function executionRule(side, optionType) {
  return EXECUTION_SEQUENCE.find(x => x.side === side && x.option_type === optionType) || null;
}

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function distanceClass(type, strike, spot) {
  if (strike === spot) return 'ATM';
  if (type === 'CE') return strike < spot ? 'ITM' : 'OTM';
  return strike > spot ? 'ITM' : 'OTM';
}

function candidateFrom(row, optionType, spot, index) {
  const option = optionType === 'CE' ? row.call_options : row.put_options;
  if (!option || !option.instrument_key) return null;
  const market = option.market_data || {};
  const greeks = option.option_greeks || {};
  const strike = num(row.strike_price, NaN);
  if (!Number.isFinite(strike)) return null;
  const bid = num(market.bid_price, NaN);
  const ask = num(market.ask_price, NaN);
  const ltp = num(market.ltp, NaN);
  const oi = num(market.oi, 0);
  const volume = num(market.volume, 0);
  const delta = num(greeks.delta, NaN);
  const spread = Number.isFinite(bid) && Number.isFinite(ask) ? Math.max(0, ask - bid) : NaN;
  const mid = Number.isFinite(bid) && Number.isFinite(ask) && (bid + ask) > 0 ? (bid + ask) / 2 : NaN;
  const spreadPct = Number.isFinite(spread) && Number.isFinite(mid) && mid > 0 ? (spread / mid) * 100 : NaN;
  return {
    index,
    strike,
    option_type: optionType,
    instrument_key: option.instrument_key,
    market,
    greeks,
    ltp,
    bid,
    ask,
    oi,
    volume,
    delta,
    abs_delta: Number.isFinite(delta) ? Math.abs(delta) : NaN,
    spread,
    spread_pct: spreadPct,
    distance: Math.abs(strike - spot),
    distance_mode: distanceClass(optionType, strike, spot),
    contract: option.contract || null
  };
}

function fail(res, reason, details = {}) {
  return res.status(422).json({
    error: 'OPTION_SELECTION_FAILED',
    reason,
    ...details
  });
}

export default async function(req, res) {
  const q = req.query || {};
  const underlying = q.underlying || 'NIFTY 50';
  const expiryRequest = q.expiry || 'current_week';
  const optionType = q.option_type || 'CE';
  const side = q.side === 'BUY' ? 'BUY' : 'SELL';
  const method = q.selection_method || 'ATM';
  const distanceMode = q.distance_mode || 'ATM';
  const instrumentKey = UNDERLYINGS[underlying];
  const execution = executionRule(side, optionType);

  if (!instrumentKey) return res.status(400).json({ error: 'UNSUPPORTED_UNDERLYING' });
  if (!EXPIRIES.has(expiryRequest) && !/^\d{4}-\d{2}-\d{2}$/.test(expiryRequest)) return res.status(400).json({ error: 'INVALID_EXPIRY' });
  if (!TYPES.has(optionType)) return res.status(400).json({ error: 'INVALID_OPTION_TYPE' });
  if (!METHODS.has(method)) return res.status(400).json({ error: 'INVALID_SELECTION_METHOD' });
  if (!DISTANCES.has(distanceMode)) return res.status(400).json({ error: 'INVALID_DISTANCE_MODE' });

  const strikeOffset = num(q.strike_offset, 0);
  const targetPremium = num(q.target_premium, NaN);
  const premiumTolerance = Math.max(0, num(q.premium_tolerance, 5));
  const targetDelta = num(q.target_delta, NaN);
  const deltaTolerance = Math.max(0, num(q.delta_tolerance, 0.1));
  const customStrike = num(q.custom_strike, NaN);
  const minOi = Math.max(0, num(q.min_oi, 0));
  const minVolume = Math.max(0, num(q.min_volume, 0));
  const maxSpreadPct = Math.max(0, num(q.max_spread_pct, 10));

  if (method === 'STRIKE_OFFSET' && (!Number.isInteger(strikeOffset) || strikeOffset < 0)) return res.status(400).json({ error: 'INVALID_STRIKE_OFFSET' });
  if (method === 'PREMIUM' && !Number.isFinite(targetPremium)) return res.status(400).json({ error: 'TARGET_PREMIUM_REQUIRED' });
  if (method === 'DELTA' && (!Number.isFinite(targetDelta) || targetDelta < 0 || targetDelta > 1)) return res.status(400).json({ error: 'TARGET_DELTA_REQUIRED' });
  if (method === 'CUSTOM_STRIKE' && !Number.isFinite(customStrike)) return res.status(400).json({ error: 'CUSTOM_STRIKE_REQUIRED' });

  const { rows: connections } = await db.query(
    'SELECT access_token, expires_at, status FROM broker_connections WHERE user_id = $1',
    [req.user.id]
  );
  const connection = connections[0];
  if (!connection || connection.status !== 'CONNECTED' || !connection.access_token) return res.status(409).json({ error: 'UPSTOX_NOT_CONNECTED' });
  if (connection.expires_at && new Date(connection.expires_at).getTime() <= Date.now()) return res.status(409).json({ error: 'UPSTOX_TOKEN_EXPIRED' });

  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token };
  const chainUrl = 'https://api.upstox.com/v2/option/chain?instrument_key=' + encodeURIComponent(instrumentKey) + '&expiry_date=' + encodeURIComponent(expiryRequest);
  const chainResponse = await fetch(chainUrl, { headers });
  const chain = await chainResponse.json().catch(() => ({}));
  if (chainResponse.status === 401) {
    await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
    return res.status(401).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
  }
  if (!chainResponse.ok || chain.status !== 'success') return res.status(502).json({ error: 'UPSTOX_MARKET_DATA_FAILED', upstream_status: chainResponse.status });

  const rowsData = Array.isArray(chain.data) ? chain.data : [];
  const spot = num(rowsData[0]?.underlying_spot_price, NaN);
  const expiry = rowsData[0]?.expiry || null;
  if (!Number.isFinite(spot) || !rowsData.length) return fail(res, 'NO_OPTION_CHAIN_DATA', { underlying, expiry_request: expiryRequest });

  let metadata = [];
  if (expiry) {
    const contractsResponse = await fetch(
      'https://api.upstox.com/v2/option/contract?instrument_key=' + encodeURIComponent(instrumentKey) + '&expiry_date=' + encodeURIComponent(expiry),
      { headers }
    );
    const contractsData = await contractsResponse.json().catch(() => ({}));
    if (contractsResponse.status === 401) {
      await db.query("UPDATE broker_connections SET status='EXPIRED', updated_at=now() WHERE user_id=$1", [req.user.id]);
      return res.status(401).json({ error: 'UPSTOX_TOKEN_EXPIRED' });
    }
    if (contractsResponse.ok && contractsData.status === 'success' && Array.isArray(contractsData.data)) metadata = contractsData.data;
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

  const candidates = rowsData.map((row, index) => {
    const c = candidateFrom(row, optionType, spot, index);
    if (c) c.contract = metaByKey.get(c.instrument_key) || c.contract;
    return c;
  }).filter(Boolean);

  const reasons = { missing_contract: 0, min_oi: 0, min_volume: 0, spread: 0, distance: 0, target: 0 };
  const eligible = [];
  for (const c of candidates) {
    if (!c.instrument_key) { reasons.missing_contract++; continue; }
    if (c.oi < minOi) { reasons.min_oi++; continue; }
    if (c.volume < minVolume) { reasons.min_volume++; continue; }
    if (maxSpreadPct > 0 && (!Number.isFinite(c.spread_pct) || c.spread_pct > maxSpreadPct)) { reasons.spread++; continue; }
    if (method !== 'ATM' && method !== 'CUSTOM_STRIKE' && distanceMode !== 'ATM' && c.distance_mode !== distanceMode) { reasons.distance++; continue; }
    if (method === 'CUSTOM_STRIKE' && c.strike !== customStrike) { reasons.target++; continue; }
    eligible.push(c);
  }

  if (!eligible.length) return fail(res, 'NO_LIQUID_ELIGIBLE_CONTRACT', {
    underlying, expiry, spot, option_type: optionType, selection_method: method,
    filters: { min_oi: minOi, min_volume: minVolume, max_spread_pct: maxSpreadPct, distance_mode: distanceMode },
    candidate_count: candidates.length, rejection_counts: reasons
  });

  let pool = eligible;
  let selectionTarget = null;
  if (method === 'ATM') {
    const minDistance = Math.min(...pool.map(c => c.distance));
    pool = pool.filter(c => c.distance === minDistance);
    selectionTarget = { spot, rule: 'nearest strike to spot' };
  } else if (method === 'STRIKE_OFFSET') {
    const sorted = [...pool].sort((a, b) => a.strike - b.strike || a.instrument_key.localeCompare(b.instrument_key));
    const atmIndex = sorted.reduce((best, c, i) => {
      const bestDistance = Math.abs(sorted[best].strike - spot);
      const distance = Math.abs(c.strike - spot);
      return distance < bestDistance ? i : best;
    }, 0);
    const direction = distanceMode === 'ITM' ? (optionType === 'CE' ? -1 : 1) : (distanceMode === 'OTM' ? (optionType === 'CE' ? 1 : -1) : 0);
    const targetIndex = atmIndex + direction * strikeOffset;
    if (targetIndex < 0 || targetIndex >= sorted.length) return fail(res, 'STRIKE_OFFSET_OUT_OF_RANGE', { strike_offset: strikeOffset, distance_mode: distanceMode, candidate_count: sorted.length });
    const targetStrike = sorted[targetIndex].strike;
    pool = pool.filter(c => c.strike === targetStrike);
    selectionTarget = { atm_strike: sorted[atmIndex].strike, target_strike: targetStrike, strike_offset: strikeOffset, distance_mode: distanceMode };
  } else if (method === 'PREMIUM') {
    pool = pool.filter(c => Number.isFinite(c.ltp) && c.ltp >= targetPremium - premiumTolerance && c.ltp <= targetPremium + premiumTolerance);
    if (!pool.length) return fail(res, 'PREMIUM_TARGET_NOT_SATISFIED', { target_premium: targetPremium, tolerance: premiumTolerance, candidate_count: eligible.length });
    selectionTarget = { target_premium: targetPremium, tolerance: premiumTolerance };
  } else if (method === 'DELTA') {
    pool = pool.filter(c => Number.isFinite(c.abs_delta) && c.abs_delta >= targetDelta - deltaTolerance && c.abs_delta <= targetDelta + deltaTolerance);
    if (!pool.length) return fail(res, 'DELTA_TARGET_NOT_SATISFIED', { target_delta: targetDelta, tolerance: deltaTolerance, candidate_count: eligible.length });
    selectionTarget = { target_delta: targetDelta, tolerance: deltaTolerance };
  } else if (method === 'CUSTOM_STRIKE') {
    selectionTarget = { custom_strike: customStrike };
  }

  const ranked = [...pool].sort((a, b) => {
    if (method === 'PREMIUM') {
      const d = Math.abs(a.ltp - targetPremium) - Math.abs(b.ltp - targetPremium);
      if (d) return d;
    }
    if (method === 'DELTA') {
      const d = Math.abs(a.abs_delta - targetDelta) - Math.abs(b.abs_delta - targetDelta);
      if (d) return d;
    }
    if (method === 'ATM' || method === 'STRIKE_OFFSET') {
      const d = Math.abs(a.strike - (selectionTarget.target_strike ?? spot)) - Math.abs(b.strike - (selectionTarget.target_strike ?? spot));
      if (d) return d;
    }
    const sa = Number.isFinite(a.spread_pct) ? a.spread_pct : Infinity;
    const sb = Number.isFinite(b.spread_pct) ? b.spread_pct : Infinity;
    if (sa !== sb) return sa - sb;
    if (a.oi !== b.oi) return b.oi - a.oi;
    return a.instrument_key.localeCompare(b.instrument_key);
  });

  const selected = ranked[0];
  return res.json({
    source: 'UPSTOX',
    as_of: new Date().toISOString(),
    underlying,
    instrument_key: instrumentKey,
    expiry_request: expiryRequest,
    expiry,
    spot,
    option_type: optionType,
    side,
    execution_sequence: execution ? {
      rank: execution.rank,
      label: execution.label,
      rule: 'BUY CE > BUY PE > SELL CE > SELL PE'
    } : null,
    selection_method: method,
    selection_target: selectionTarget,
    filters: { min_oi: minOi, min_volume: minVolume, max_spread_pct: maxSpreadPct, distance_mode: distanceMode },
    candidate_count: candidates.length,
    eligible_count: eligible.length,
    selected: {
      strike: selected.strike,
      instrument_key: selected.instrument_key,
      option_type: selected.option_type,
      ltp: selected.ltp,
      bid: selected.bid,
      ask: selected.ask,
      spread: selected.spread,
      spread_pct: selected.spread_pct,
      oi: selected.oi,
      volume: selected.volume,
      delta: selected.delta,
      abs_delta: selected.abs_delta,
      distance_mode: selected.distance_mode,
      contract: selected.contract
    }
  });
}