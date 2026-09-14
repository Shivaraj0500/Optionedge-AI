import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

export default async function(req, res) {
  const { rows } = await db.query(
    'SELECT broker, user_name, email, connected_at, expires_at, status FROM broker_connections WHERE user_id = $1',
    [req.user.id]
  );
  const connection = rows[0] || null;
  return res.json({ connected: !!connection && connection.status === 'CONNECTED', connection });
}