// Point d'entree WebSocket sur Vercel : wss://<domaine>/api/ws?room=CODE
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createGame } from '../lib/game.js';
import { makeStore } from '../lib/store.js';
import { createAccounts } from '../lib/accounts.js';

const store = await makeStore();
const game = createGame(store, { accounts: createAccounts(store) });
const server = http.createServer((req, res) => { res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Connexion WebSocket attendue.'); });
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', 'http://localhost');
  game.onConnection(ws, url.searchParams.get('room') || '');
});

export default server;
