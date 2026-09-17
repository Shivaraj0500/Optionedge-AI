// OptionEdge AI global trading policy.
// All intraday strategies are hard-limited to this square-off time (IST).
export const INTRADAY_SQUARE_OFF = '15:15';

export function minutesOf(v) {
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function effectiveIntradaySquareOff(requested) {
  const requestedMinutes = minutesOf(requested);
  const hardMinutes = minutesOf(INTRADAY_SQUARE_OFF);
  return Number.isFinite(requestedMinutes) && requestedMinutes < hardMinutes
    ? String(requested).padStart(5, '0')
    : INTRADAY_SQUARE_OFF;
}

export function isAfterIntradaySquareOff(nowMinutes) {
  return Number(nowMinutes) >= minutesOf(INTRADAY_SQUARE_OFF);
}