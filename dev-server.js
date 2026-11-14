// Serveur de developpement local : sert public/ et le meme point d'entree /api/ws que sur Vercel.
//   npm install && npm run dev      puis http://localhost:3000
// COUPURE=20 npm run dev            coupe chaque connexion apres 20 s, pour tester la reconnexion.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createGame } from './lib/game.js';
import { makeStore } from './lib/store.js';
import { createAccounts } from './lib/accounts.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const PORT = Number(process.env.PORT) || 3000, CUT = Number(process.env.COUPURE) || 0;
const store = await makeStore(), accounts = createAccounts(store);
const game = createGame(store, { accounts });

const server = http.createServer(async (req, res) => {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/api/account') {   // meme logique que api/account.js, branchee sur le store local
    let raw = ''; for await (const c of req) raw += c; let b = {}; try { b = JSON.parse(raw || '{}'); } catch (_) {}
    const f = { signup: () => accounts.signup(b.pseudo, b.code, b.pays), pays: () => accounts.setPays(b.session, b.pays), top: () => accounts.top(b.by, b.session), login: () => accounts.login(b.pseudo, b.code), me: () => accounts.me(b.session), logout: () => accounts.logout(b.session), cfg: () => accounts.setCfg(b.session, b.cfg) }[b.action];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(f ? await f() : { ok: false, err: 'action' })); return;
  }
  if (p === '/') p = '/index.html'; if (!path.extname(p)) p += '.html';
  const file = path.join(PUB, path.normalize(p)); if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body); }
  catch (_) { res.writeHead(404); res.end('Introuvable'); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x'); if (url.pathname !== '/api/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => { game.onConnection(ws, url.searchParams.get('room') || ''); if (CUT) setTimeout(() => ws.terminate(), CUT * 1000); });
});
server.listen(PORT, () => console.log('La Grande Descente (dev) : http://localhost:' + PORT));
