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

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const PORT = Number(process.env.PORT) || 3000, CUT = Number(process.env.COUPURE) || 0;
const game = createGame(await makeStore());

const server = http.createServer(async (req, res) => {
  let p = new URL(req.url, 'http://x').pathname; if (p === '/') p = '/index.html'; if (!path.extname(p)) p += '.html';
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
