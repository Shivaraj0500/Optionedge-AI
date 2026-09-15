import { auth, db } from 'hatchable';

export const access = 'public';
export const methods = ['GET'];

async function verify(value, signature, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = signature.match(/.{2}/g)?.map(x => parseInt(x, 16));
  if (!bytes || bytes.length !== 32) return false;
  return crypto.subtle.verify('HMAC', key, new Uint8Array(bytes), new TextEncoder().encode(value));
}

export default async function(req, res) {
  const user = await auth.getUser(req);
  const code = req.query?.code;
  const state = req.query?.state;
  const error = req.query?.error;
  if (error) return res.redirect('/?broker=error');
  if (!user) return res.status(401).send('Your OptionEdge AI session was not available for the broker callback. Please sign in and start Connect Upstox again.');
  if (!code || !state) return res.status(400).send('Missing Upstox authorization code.');

  const client = process.env.UPSTOX_CLIENT_ID;
  const secret = process.env.UPSTOX_CLIENT_SECRET;
  const redirect = 'https://optionedge-ai-hrdh.hatchable.site/api/upstox-callback';
  if (!client || !secret) return res.status(503).send('Upstox configuration is incomplete.');

  try {
    const dot = state.lastIndexOf('.');
    if (dot < 1) return res.status(403).send('Invalid Upstox connection state. Restart the connection from OptionEdge AI.');
    const encodedPayload = state.slice(0, dot);
    const signature = state.slice(dot + 1);
    const payload = decodeURIComponent(encodedPayload);
    if (!(await verify(payload, signature, secret))) return res.status(403).send('Invalid Upstox connection state. Restart the connection from OptionEdge AI.');

    let claims;
    try { claims = JSON.parse(payload); } catch { return res.status(403).send('Invalid Upstox connection state. Restart the connection from OptionEdge AI.'); }
    if (String(claims.u) !== String(user.id) || !claims.t || Date.now() - Number(claims.t) > 10 * 60 * 1000) {
      return res.status(403).send('This Upstox connection attempt has expired. Restart the connection from OptionEdge AI.');
    }

    const body = new URLSearchParams({ code, client_id: client, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' });
    const token = await fetch('https://api.upstox.com/v2/login/authorization/token', { method: 'POST', headers: { accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await token.json();
    if (!token.ok || !data.access_token) {
      console.error('Upstox token exchange failed', JSON.stringify({ status: token.status, error: data?.errors || data?.error || null }));
      return res.status(502).send('Upstox token exchange failed. Restart the connection from OptionEdge AI.');
    }

    let profile = {};
    try {
      const p = await fetch('https://api.upstox.com/v2/user/profile', { headers: { Accept: 'application/json', Authorization: 'Bearer ' + data.access_token } });
      profile = (await p.json()).data || {};
    } catch {}

    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await db.query(
      'INSERT INTO broker_connections (user_id, access_token, refresh_token, user_name, email, connected_at, expires_at, status, updated_at) VALUES ($1,$2,$3,$4,$5,now(),$6,$7,now()) ON CONFLICT (user_id) DO UPDATE SET access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token, user_name=EXCLUDED.user_name, email=EXCLUDED.email, connected_at=EXCLUDED.connected_at, expires_at=EXCLUDED.expires_at, status=EXCLUDED.status, updated_at=now()',
      [user.id, data.access_token, data.refresh_token || null, profile.user_name || profile.user_id || '', profile.email || user.email || '', expires, 'CONNECTED']
    );
    return res.redirect('/?broker=connected');
  } catch (e) {
    console.error('Upstox callback failed', e);
    return res.status(502).send('Upstox connection failed. Restart the connection from OptionEdge AI.');
  }
}