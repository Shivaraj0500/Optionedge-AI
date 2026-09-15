import { db } from 'hatchable';

export const access = 'user';
export const methods = ['POST'];

const UNDERLYINGS = new Set(['NIFTY 50', 'BANK NIFTY', 'SENSEX', 'BANKEX']);
const SEQUENCE = {
  'BUY:CE': 1,
  'BUY:PE': 2,
  'SELL:CE': 3,
  'SELL:PE': 4,
};

function sequenceFor(side, optionType) {
  return SEQUENCE[`${side}:${optionType}`] || 99;
}

export default async function(req, res) {
  const body = req.body || {};
  const underlying = String(body.underlying || '');
  const expiry = String(body.expiry || '');
  const legs = Array.isArray(body.legs) ? body.legs : [];
  const errors = [];
  const warnings = [];

  if (!UNDERLYINGS.has(underlying)) errors.push('Unsupported underlying.');
  if (!expiry) errors.push('Resolved expiry is required.');
  if (!legs.length) errors.push('At least one resolved leg is required.');

  const seen = new Set();
  const normalized = legs.map((leg, index) => {
    const side = leg.side === 'BUY' ? 'BUY' : leg.side === 'SELL' ? 'SELL' : '';
    const optionType = leg.option_type === 'CE' ? 'CE' : leg.option_type === 'PE' ? 'PE' : '';
    const rank = sequenceFor(side, optionType);
    const selected = leg.selected || {};
    const instrumentKey = String(selected.instrument_key || '');
    const contract = selected.contract || {};
    const lotSize = Number(contract.lot_size || 0);
    const minimumLot = Number(contract.minimum_lot || 0);
    const duplicateKey = instrumentKey || `missing-${index}`;

    if (!side) errors.push(`Leg ${index + 1}: invalid side.`);
    if (!optionType) errors.push(`Leg ${index + 1}: invalid option type.`);
    if (!instrumentKey) errors.push(`Leg ${index + 1}: missing Upstox instrument key.`);
    if (seen.has(duplicateKey)) errors.push(`Leg ${index + 1}: duplicate instrument key ${instrumentKey}.`);
    seen.add(duplicateKey);
    if (!Number.isFinite(Number(selected.strike)) || Number(selected.strike) <= 0) errors.push(`Leg ${index + 1}: invalid strike.`);
    if (Number(selected.spread_pct) > 10) warnings.push(`Leg ${index + 1}: spread is above the default 10% observation threshold.`);
    return {
      leg_id: String(leg.leg_id || `leg-${index + 1}`),
      role: leg.role === 'HEDGE' ? 'HEDGE' : 'PRIMARY',
      side,
      option_type: optionType,
      execution_rank: rank,
      strike: Number(selected.strike),
      instrument_key: instrumentKey,
      trading_symbol: contract.trading_symbol || null,
      lot_size: lotSize || null,
      minimum_lot: minimumLot || null,
    };
  });

  const ordered = [...normalized].sort((a, b) => a.execution_rank - b.execution_rank || a.leg_id.localeCompare(b.leg_id));
  const actualRanks = normalized.map(x => x.execution_rank);
  const sortedRanks = [...actualRanks].sort((a, b) => a - b);
  if (actualRanks.some((rank, i) => rank !== sortedRanks[i])) {
    errors.push('Execution order violation: legs must resolve in BUY CE → BUY PE → SELL CE → SELL PE order.');
  }

  const hasBuy = normalized.some(x => x.side === 'BUY');
  const hasSell = normalized.some(x => x.side === 'SELL');
  if (hasBuy && hasSell) {
    const firstSell = Math.min(...normalized.filter(x => x.side === 'SELL').map(x => x.execution_rank));
    const lastBuy = Math.max(...normalized.filter(x => x.side === 'BUY').map(x => x.execution_rank));
    if (lastBuy >= firstSell) errors.push('Buy protection legs must complete before any sell leg is permitted.');
  }

  const buyCE = normalized.filter(x => x.side === 'BUY' && x.option_type === 'CE');
  const buyPE = normalized.filter(x => x.side === 'BUY' && x.option_type === 'PE');
  const sellCE = normalized.filter(x => x.side === 'SELL' && x.option_type === 'CE');
  const sellPE = normalized.filter(x => x.side === 'SELL' && x.option_type === 'PE');
  if (buyCE.length && buyPE.length && Math.min(...buyCE.map(x => x.execution_rank)) > Math.min(...buyPE.map(x => x.execution_rank))) errors.push('BUY CE must precede BUY PE.');
  if (sellCE.length && sellPE.length && Math.min(...sellCE.map(x => x.execution_rank)) > Math.min(...sellPE.map(x => x.execution_rank))) errors.push('SELL CE must precede SELL PE.');

  const primary = normalized.filter(x => x.role === 'PRIMARY');
  const hedge = normalized.filter(x => x.role === 'HEDGE');
  if (hedge.length && !primary.length) errors.push('Hedge legs require at least one primary leg.');
  if (hedge.length && hasSell && !hasBuy) warnings.push('This structure contains sell legs but no buy protection legs.');

  const valid = errors.length === 0;
  return res.json({
    valid,
    status: valid ? 'STRUCTURE_VALIDATED' : 'STRUCTURE_BLOCKED',
    underlying,
    expiry,
    execution_rule: 'BUY CE > BUY PE > SELL CE > SELL PE',
    execution_order: ordered,
    errors,
    warnings,
    live_orders_enabled: false,
    note: 'Structure validation does not submit broker orders.'
  });
}