// Comptes pilotes : POST /api/account  { action: 'signup' | 'login' | 'me' | 'logout' | 'cfg' | 'pays' | 'top', ... }
import { createAccounts } from '../lib/accounts.js';
import { makeStore } from '../lib/store.js';

const accounts = createAccounts(await makeStore());

export async function handleAccount(body) {
  const b = body && typeof body === 'object' ? body : {};
  switch (b.action) {
    case 'signup': return accounts.signup(b.pseudo, b.code, b.pays);
    case 'pays': return accounts.setPays(b.session, b.pays);
    case 'top': return accounts.top(b.by, b.session);
    case 'login': return accounts.login(b.pseudo, b.code);
    case 'me': return accounts.me(b.session);
    case 'logout': return accounts.logout(b.session);
    case 'cfg': return accounts.setCfg(b.session, b.cfg);
    default: return { ok: false, err: 'action' };
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return {}; } }
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) break; }
  try { return JSON.parse(raw || '{}'); } catch (_) { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ ok: false, err: 'methode' })); return; }
  try { res.statusCode = 200; res.end(JSON.stringify(await handleAccount(await readBody(req)))); }
  catch (e) { console.error('[account]', e.message); res.statusCode = 500; res.end(JSON.stringify({ ok: false, err: 'serveur' })); }
}
