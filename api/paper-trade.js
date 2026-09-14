import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET', 'POST'];

export default async function(req, res) {
  const user = req.user;

  if (req.method === 'GET') {
    const { rows } = await db.query(
      'SELECT id, strategy_id, underlying, side, option_type, strike, quantity, entry_price, exit_price, status, opened_at, closed_at FROM paper_positions WHERE user_id = $1 ORDER BY opened_at DESC LIMIT 100',
      [user.id]
    );
    return res.json({ positions: rows });
  }

  const b = req.body || {};
  const quantity = Number(b.quantity);
  const strike = Number(b.strike);
  const entryPrice = Number(b.entry_price);
  if (!['BUY', 'SELL'].includes(String(b.side)) || !['CE', 'PE'].includes(String(b.option_type)) || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(strike) || !Number.isFinite(entryPrice) || entryPrice < 0) {
    return res.status(400).json({ error: 'Invalid paper position.' });
  }

  const { rows } = await db.query(
    'INSERT INTO paper_positions (user_id, strategy_id, underlying, side, option_type, strike, quantity, entry_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [user.id, b.strategy_id || null, String(b.underlying || 'NIFTY 50'), String(b.side), String(b.option_type), strike, Math.trunc(quantity), entryPrice]
  );
  return res.status(201).json({ position: rows[0] });
}