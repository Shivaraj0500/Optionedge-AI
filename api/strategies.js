import { db, auth } from 'hatchable';

export const access = 'user';
export const methods = ['GET', 'POST', 'PUT'];

const ALLOWED_UNDERLYINGS = ['NIFTY 50', 'BANK NIFTY', 'SENSEX', 'BANKEX'];
const ALLOWED_TIMEFRAMES = ['3m', '5m', '15m', '30m', '1h'];
const ALLOWED_CANDLES = ['OHLC', 'HEIKIN_ASHI'];
const ALLOWED_SIDES = ['BUY', 'SELL'];
const ALLOWED_TYPES = ['CE', 'PE'];
const ALLOWED_SELECTION = ['ATM', 'STRIKE_OFFSET', 'PREMIUM', 'DELTA', 'CUSTOM_STRIKE'];
const ALLOWED_EXPIRIES = ['current_week', 'next_week', 'far_week', 'current_month', 'next_month', 'far_month'];

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanLeg(raw, index) {
  const leg = raw || {};
  const optionType = ALLOWED_TYPES.includes(leg.option_type) ? leg.option_type : 'CE';
  const side = ALLOWED_SIDES.includes(leg.side) ? leg.side : 'SELL';
  const selectionMethod = ALLOWED_SELECTION.includes(leg.selection_method) ? leg.selection_method : 'ATM';
  const distanceMode = leg.distance_mode === 'ITM' ? 'ITM' : 'OTM';
  return {
    id: String(leg.id || `leg-${index + 1}`),
    role: leg.role === 'HEDGE' ? 'HEDGE' : 'PRIMARY',
    enabled: leg.enabled !== false,
    label: String(leg.label || `${side} ${optionType}`),
    option_type: optionType,
    side,
    quantity: clampInt(leg.quantity, 1, 100000, 1),
    lots: clampInt(leg.lots, 1, 1000, 1),
    selection_method: selectionMethod,
    distance_mode: distanceMode,
    strike_offset: clampInt(leg.strike_offset, -100, 100, 0),
    target_premium: clampNum(leg.target_premium, 0, 100000, 0),
    premium_tolerance: clampNum(leg.premium_tolerance, 0, 100000, 5),
    target_delta: clampNum(leg.target_delta, 0, 1, 0.5),
    delta_tolerance: clampNum(leg.delta_tolerance, 0, 1, 0.1),
    custom_strike: leg.custom_strike === '' || leg.custom_strike == null ? null : Number(leg.custom_strike),
    min_oi: clampNum(leg.min_oi, 0, 1000000000, 0),
    min_volume: clampNum(leg.min_volume, 0, 1000000000, 0),
    max_spread: clampNum(leg.max_spread, 0, 100000, 100),
    max_spread_pct: clampNum(leg.max_spread_pct, 0, 1000, 10),
  };
}

function normalizeConfig(body) {
  const timeframe = ALLOWED_TIMEFRAMES.includes(body.timeframe) ? body.timeframe : '15m';
  const candleType = ALLOWED_CANDLES.includes(body.candle_type) ? body.candle_type : 'OHLC';
  const underlying = ALLOWED_UNDERLYINGS.includes(body.underlying) ? body.underlying : 'NIFTY 50';
  const optionExpiry = ALLOWED_EXPIRIES.includes(body.option_expiry) ? body.option_expiry : 'current_week';
  const squareOff = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.square_off || '')) ? String(body.square_off) : '15:15';
  const startTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.start_time || '')) ? String(body.start_time) : '09:45';
  const legs = Array.isArray(body.legs) ? body.legs.map(cleanLeg).filter(l => l.enabled) : [];
  if (legs.length === 0) {
    legs.push(cleanLeg({ option_type: 'CE', side: 'SELL', role: 'PRIMARY', selection_method: 'ATM', label: 'SELL ATM CE' }, 0));
    legs.push(cleanLeg({ option_type: 'PE', side: 'SELL', role: 'PRIMARY', selection_method: 'ATM', label: 'SELL ATM PE' }, 1));
  }
  return {
    name: String(body.name || 'Untitled Strategy').trim().slice(0, 120),
    underlying,
    option_expiry: optionExpiry,
    timeframe,
    candle_type: candleType,
    start_time: startTime,
    square_off: squareOff,
    overnight_exposure: body.overnight_exposure === true,
    adx_period: clampInt(body.adx_period, 2, 200, 14),
    adx_threshold: clampNum(body.adx_threshold, 1, 100, 22),
    atr_period: clampInt(body.atr_period, 2, 200, 14),
    atr_multiplier: clampNum(body.atr_multiplier, 0.1, 20, 2),
    confirmation_candles: clampInt(body.confirmation_candles, 0, 10, 1),
    regime_rule: {
      mode: String(body.regime_rule?.mode || 'ADX_RANGE'),
      adx_less_than: clampNum(body.regime_rule?.adx_less_than, 1, 100, 22),
      adx_below_plus_di: body.regime_rule?.adx_below_plus_di !== false,
      adx_below_minus_di: body.regime_rule?.adx_below_minus_di !== false,
    },
    roll_mode: 'CLOSED_CANDLE_OUTSIDE_CORRIDOR',
    legs,
    margin_config: {
      show_estimate: body.margin_config?.show_estimate !== false,
      broker_margin_live: false,
    },
  };
}

function asStrategy(row) {
  const config = row.leg_config && typeof row.leg_config === 'object' ? row.leg_config : [];
  return {
    id: row.id,
    name: row.name,
    underlying: row.underlying,
    option_expiry: row.option_expiry || 'current_week',
    timeframe: row.timeframe,
    candle_type: row.candle_type,
    start_time: row.start_time,
    square_off: row.square_off,
    overnight_exposure: row.overnight_exposure,
    adx_period: row.adx_period,
    adx_threshold: Number(row.adx_threshold),
    atr_period: row.atr_period,
    atr_multiplier: Number(row.atr_multiplier),
    confirmation_candles: row.confirmation_candles,
    regime_rule: row.regime_rule,
    roll_mode: row.roll_mode,
    legs: config,
    margin_config: row.margin_config,
    version: row.version,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function latestVersion(strategyId, userId) {
  const q = await db.query(
    'SELECT id, version_number, config, status, created_at FROM strategy_versions WHERE strategy_id = $1 AND user_id = $2 ORDER BY version_number DESC LIMIT 1',
    [strategyId, userId]
  );
  return q.rows[0] || null;
}

export default async function (req, res) {
  const user = req.user;

  if (req.method === 'GET') {
    const q = await db.query(
      'SELECT * FROM strategy_configs WHERE user_id = $1 ORDER BY updated_at DESC',
      [user.id]
    );
    return res.json({ strategies: q.rows.map(asStrategy) });
  }

  if (req.method === 'POST') {
    const config = normalizeConfig(req.body || {});
    const inserted = await db.query(
      `INSERT INTO strategy_configs
        (user_id, name, underlying, option_expiry, timeframe, candle_type, start_time, square_off, overnight_exposure,
         adx_period, adx_threshold, atr_period, atr_multiplier, confirmation_candles, regime_rule,
         roll_mode, leg_config, margin_config, version, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,1,false)
       RETURNING *`,
      [user.id, config.name, config.underlying, config.option_expiry, config.timeframe, config.candle_type, config.start_time,
       config.square_off, config.overnight_exposure, config.adx_period, config.adx_threshold,
       config.atr_period, config.atr_multiplier, config.confirmation_candles, JSON.stringify(config.regime_rule),
       config.roll_mode, JSON.stringify(config.legs), JSON.stringify(config.margin_config)]
    );
    const strategy = inserted.rows[0];
    await db.transaction([
      {
        sql: 'INSERT INTO strategy_versions (strategy_id, user_id, version_number, status, config) VALUES ($1,$2,$3,$4,$5)',
        params: [strategy.id, user.id, 1, 'DRAFT', JSON.stringify(config)],
      },
      {
        sql: 'INSERT INTO audit_events (user_id, event_type, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
        params: [user.id, 'STRATEGY_CREATED', 'strategy', strategy.id, JSON.stringify({ version: 1, name: config.name })],
      },
    ]);
    return res.status(201).json({ strategy: asStrategy(strategy), version: 1 });
  }

  const strategyId = String(req.body?.id || '');
  if (!strategyId) return res.status(400).json({ error: 'strategy id required' });

  if (req.method === 'PUT') {
    const existing = await db.query('SELECT * FROM strategy_configs WHERE id = $1 AND user_id = $2 LIMIT 1', [strategyId, user.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'strategy not found' });
    const current = asStrategy(existing.rows[0]);
    const config = normalizeConfig({ ...current, ...(req.body || {}) });
    const nextVersion = Number(current.version || 1) + 1;
    const updated = await db.query(
      `UPDATE strategy_configs
       SET name=$1, underlying=$2, option_expiry=$3, timeframe=$4, candle_type=$5, start_time=$6, square_off=$7,
           overnight_exposure=$8, adx_period=$9, adx_threshold=$10, atr_period=$11, atr_multiplier=$12,
           confirmation_candles=$13, regime_rule=$14, roll_mode=$15, leg_config=$16, margin_config=$17,
           version=$18, updated_at=now()
       WHERE id=$19 AND user_id=$20
       RETURNING *`,
      [config.name, config.underlying, config.option_expiry, config.timeframe, config.candle_type, config.start_time, config.square_off,
       config.overnight_exposure, config.adx_period, config.adx_threshold, config.atr_period, config.atr_multiplier,
       config.confirmation_candles, JSON.stringify(config.regime_rule), config.roll_mode, JSON.stringify(config.legs),
       JSON.stringify(config.margin_config), nextVersion, strategyId, user.id]
    );
    await db.transaction([
      {
        sql: 'INSERT INTO strategy_versions (strategy_id, user_id, version_number, status, config) VALUES ($1,$2,$3,$4,$5)',
        params: [strategyId, user.id, nextVersion, 'DRAFT', JSON.stringify(config)],
      },
      {
        sql: 'INSERT INTO audit_events (user_id, event_type, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
        params: [user.id, 'STRATEGY_VERSION_CREATED', 'strategy', strategyId, JSON.stringify({ version: nextVersion })],
      },
    ]);
    return res.json({ strategy: asStrategy(updated.rows[0]), version: nextVersion });
  }

  return res.status(405).json({ error: 'method not allowed' });
}