import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET', 'POST'];

export default async function(req, res) {
  const user = req.user;

  if (req.method === 'GET') {
    const { rows } = await db.query(
      'SELECT id, name, underlying, timeframe, adx_threshold, atr_multiplier, square_off, overnight_exposure, enabled, created_at, updated_at FROM strategy_configs WHERE user_id = $1 ORDER BY updated_at DESC',
      [user.id]
    );
    return res.json({ strategies: rows });
  }

  const body = req.body || {};
  const name = String(body.name || 'ADX-ATR Range Seller').trim();
  const underlying = String(body.underlying || 'NIFTY 50');
  const timeframe = String(body.timeframe || '15m');
  const adx = Number(body.adx_threshold ?? 22);
  const atr = Number(body.atr_multiplier ?? 2);
  const squareOff = String(body.square_off || '15:15');

  if (!['NIFTY 50', 'BANK NIFTY', 'SENSEX', 'BANKEX'].includes(underlying)) {
    return res.status(400).json({ error: 'Unsupported underlying.' });
  }
  if (!Number.isFinite(adx) || adx <= 0 || !Number.isFinite(atr) || atr <= 0) {
    return res.status(400).json({ error: 'ADX and ATR settings must be positive numbers.' });
  }

  const { rows } = await db.query(
    'INSERT INTO strategy_configs (user_id, name, underlying, timeframe, adx_threshold, atr_multiplier, square_off, overnight_exposure) VALUES ($1,$2,$3,$4,$5,$6,$7,false) RETURNING *',
    [user.id, name, underlying, timeframe, adx, atr, squareOff]
  );
  return res.status(201).json({ strategy: rows[0] });
}