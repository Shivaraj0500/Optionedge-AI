import { auth } from 'hatchable';

export const access = 'public';
export const methods = ['GET'];

async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function(req, res) {
  const user = await auth.getUser(req);
  if (!user) return res.redirect('/login?next=/');

  const client = process.env.UPSTOX_CLIENT_ID;
  const secret = process.env.UPSTOX_CLIENT_SECRET;
  if (!client || !secret) return res.status(503).send('Upstox credentials are not configured. Add UPSTOX_CLIENT_ID and UPSTOX_CLIENT_SECRET in Hatchable Setup.');

  const redirect = 'https://optionedge-ai-hrdh.hatchable.site/api/upstox-callback';
  const payload = JSON.stringify({ u: user.id, t: Date.now(), n: crypto.randomUUID() });
  const signature = await sign(payload, secret);
  const state = encodeURIComponent(payload) + '.' + signature;
  const url = 'https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=' + encodeURIComponent(client) + '&redirect_uri=' + encodeURIComponent(redirect) + '&state=' + encodeURIComponent(state);
  return res.redirect(url);
}