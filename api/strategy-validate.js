import { db } from 'hatchable';
import { INTRADAY_SQUARE_OFF, minutesOf } from 'lib/trading-policy.js';

export const access = 'user';
export const methods = ['POST'];

const ALLOWED_UNDERLYINGS = ['NIFTY 50', 'BANK NIFTY', 'SENSEX', 'BANKEX'];
const ALLOWED_TIMEFRAMES = ['3m', '5m', '15m', '30m', '1h'];
const ALLOWED_CANDLES = ['OHLC', 'HEIKIN_ASHI'];
const ALLOWED_SELECTION = ['ATM', 'STRIKE_OFFSET', 'PREMIUM', 'DELTA', 'CUSTOM_STRIKE'];

function validateLeg(leg, idx) {
  const errors = [];
  if (!['CE', 'PE'].includes(leg.option_type)) errors.push(`Leg ${idx + 1}: option type must be CE or PE`);
  if (!['BUY', 'SELL'].includes(leg.side)) errors.push(`Leg ${idx + 1}: side must be BUY or SELL`);
  if (!ALLOWED_SELECTION.includes(leg.selection_method)) errors.push(`Leg ${idx + 1}: invalid strike selection method`);
  if (!(Number(leg.quantity) > 0)) errors.push(`Leg ${idx + 1}: quantity must be positive`);
  if (leg.selection_method === 'PREMIUM' && !(Number(leg.target_premium) > 0)) errors.push(`Leg ${idx + 1}: target premium required`);
  if (leg.selection_method === 'DELTA' && !(Number(leg.target_delta) > 0 && Number(leg.target_delta) <= 1)) errors.push(`Leg ${idx + 1}: target delta must be between 0 and 1`);
  if (leg.selection_method === 'CUSTOM_STRIKE' && !(Number(leg.custom_strike) > 0)) errors.push(`Leg ${idx + 1}: custom strike required`);
  return errors;
}

export default async function (req, res) {
  const body = req.body || {};
  const strategyId = String(body.strategy_id || '');
  if (!strategyId) return res.status(400).json({ valid: false, errors: ['strategy_id required'] });

  const q = await db.query('SELECT * FROM strategy_configs WHERE id = $1 AND user_id = $2 LIMIT 1', [strategyId, req.user.id]);
  if (!q.rows[0]) return res.status(404).json({ valid: false, errors: ['strategy not found'] });
  const s = q.rows[0];
  const legs = Array.isArray(s.leg_config) ? s.leg_config : [];
  const errors = [];
  const warnings = [];

  if (!ALLOWED_UNDERLYINGS.includes(s.underlying)) errors.push('Unsupported underlying');
  if (!ALLOWED_TIMEFRAMES.includes(s.timeframe)) errors.push('Unsupported timeframe');
  if (!ALLOWED_CANDLES.includes(s.candle_type)) errors.push('Unsupported candle type');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start_time)) errors.push('Invalid start time');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.square_off)) errors.push('Invalid square-off time');
  else if (minutesOf(s.square_off) > minutesOf(INTRADAY_SQUARE_OFF)) errors.push(`Intraday square-off cannot be later than ${INTRADAY_SQUARE_OFF} IST`);
  if (Number(s.atr_multiplier) <= 0) errors.push('ATR multiplier must be positive');
  if (Number(s.adx_period) < 2) errors.push('ADX period must be >= 2');
  if (Number(s.atr_period) < 2) errors.push('ATR period must be >= 2');
  if (s.signal_model === 'ST_EMA_RSI_TRANSITION') {
    const sc = s.signal_config && typeof s.signal_config === 'object' ? s.signal_config : {};
    if (s.timeframe !== '15m') errors.push('ST + EMA50 + RSI transition strategy must use the 15m timeframe.');
    if (s.candle_type !== 'HEIKIN_ASHI') errors.push('ST + EMA50 + RSI transition strategy must use Heikin Ashi candles.');
    if (Number(sc.supertrend_period) < 2) errors.push('Supertrend period must be >= 2.');
    if (!(Number(sc.supertrend_multiplier) > 0)) errors.push('Supertrend multiplier must be positive.');
    if (Number(sc.ema_period) < 2) errors.push('EMA period must be >= 2.');
    if (Number(sc.rsi_period) < 2) errors.push('RSI period must be >= 2.');
    if (!(Number(sc.rsi_long_threshold) > Number(sc.rsi_short_threshold))) errors.push('RSI long threshold must be greater than RSI short threshold.');
  }
  if (s.overnight_exposure) errors.push('Overnight exposure is disabled by the global intraday policy. All intraday positions must be closed by 15:15 IST.');
  if (legs.length < 2) warnings.push('Strategy has fewer than two legs; this is allowed for custom structures but verify intent.');
  if (!legs.some(l => l.option_type === 'CE')) warnings.push('No CE leg configured.');
  if (!legs.some(l => l.option_type === 'PE')) warnings.push('No PE leg configured.');
  legs.forEach((leg, idx) => errors.push(...validateLeg(leg, idx)));

  // Execution priority is canonical and independent of the order in which
  // legs were added to the builder. Long option protection is always
  // established before any short leg is permitted to execute.
  const executionSequence = [
    'BUY CE',
    'BUY PE',
    'SELL CE',
    'SELL PE'
  ];
  const unknownExecutionLegs = legs.filter(l => !executionSequence.includes(`${l.side} ${l.option_type}`));
  if (unknownExecutionLegs.length) errors.push('Every option leg must be BUY/SELL CE/PE so the canonical execution sequence can be enforced.');

  const primary = legs.filter(l => l.role === 'PRIMARY');
  const hedge = legs.filter(l => l.role === 'HEDGE');
  if (hedge.length > 0 && primary.length === 0) errors.push('Hedge legs require at least one primary leg.');
  if (hedge.length > 0) warnings.push('Hedge-aware roll sequencing will be enforced by later execution gates.');

  const valid = errors.length === 0;
  await db.query(
    'UPDATE strategy_versions SET status = $1 WHERE strategy_id = $2 AND user_id = $3 AND version_number = (SELECT version FROM strategy_configs WHERE id = $2)',
    [valid ? 'VALIDATED' : 'DRAFT', strategyId, req.user.id]
  );
  await db.query(
    'INSERT INTO audit_events (user_id, event_type, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
    [req.user.id, valid ? 'STRATEGY_VALIDATED' : 'STRATEGY_VALIDATION_FAILED', 'strategy', strategyId, JSON.stringify({ errors, warnings })]
  );

  res.json({ valid, status: valid ? 'VALIDATED' : 'DRAFT', errors, warnings, execution_sequence: executionSequence, notes: ['No live order execution is enabled at this gate.', 'Option selection is configuration-validated only; broker/exchange contract validation is a later market-data gate.', 'Future multi-leg execution must pre-resolve every leg successfully, then execute strictly in this order: BUY CE → BUY PE → SELL CE → SELL PE. If any required precondition or leg fails, later legs must not be sent.'] });
}