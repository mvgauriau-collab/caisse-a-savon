// Verifie que deux instances de la fonction (comme sur Vercel) se coordonnent via Redis.
// Redis est simule en memoire par ioredis-mock : meme API, memes commandes.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import RedisMock from 'ioredis-mock';
import { createGame } from '../lib/game.js';
import { RedisStore } from '../lib/store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class FakeWS extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.inbox = []; }
  send(d) { this.inbox.push(JSON.parse(d)); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
  say(m) { this.emit('message', Buffer.from(JSON.stringify(m))); }
  last(t) { for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i].t === t) return this.inbox[i]; return null; }
  count(t) { return this.inbox.filter((m) => m.t === t).length; }
}
const A = createGame(new RedisStore(new RedisMock())), B = createGame(new RedisStore(new RedisMock()));
const cfg = { b: 1, w: 2, p: 3, a: 4, c: '#29a8ff', h: '#ffc93c' };
let ok = 0; const step = (name) => { ok++; console.log('  ok  ' + name); };

// 1. deux joueurs, deux instances, une meme partie
const a = new FakeWS(), b = new FakeWS();
A.onConnection(a, 'test'); a.say({ t: 'join', token: 'tok-a', name: 'Martin', cfg });
await sleep(150);
B.onConnection(b, 'TEST'); b.say({ t: 'join', token: 'tok-b', name: 'Hugo', cfg });
await sleep(200);
assert.equal(a.last('welcome').id, 1); assert.equal(b.last('welcome').id, 2); assert.equal(a.last('welcome').room, 'TEST');
assert.equal(a.last('state').players.length, 2, 'A voit les deux joueurs'); assert.equal(b.last('state').players.length, 2);
assert.equal(a.last('state').host, 1); assert.deepEqual(b.last('state').players[1].cfg, cfg);
step('deux joueurs sur deux instances se voient');

// 2. seul l'hote lance, tout le monde recoit le depart
b.say({ t: 'start' }); await sleep(120); assert.equal(a.last('start'), null, 'un non-hote ne lance pas');
a.say({ t: 'start' }); await sleep(200);
assert.ok(a.last('start') && b.last('start')); assert.equal(a.last('start').seed, b.last('start').seed); assert.deepEqual(b.last('start').racers, [1, 2]);
assert.equal(b.last('state').phase, 'race'); assert.equal(b.last('state').seed, a.last('start').seed);
step('depart synchronise avec la meme graine');

// 3. positions et evenements relayes d'une instance a l'autre, sans echo vers l'emetteur
a.say({ t: 'pos', x: 1.5, z: 42, s: 12, a: 0, d: 10, st: 0.2, r: 0, pirate: 'x' }); a.say({ t: 'wheel', w: 1001, z: 50, x: 1, s: 25, i: 0.3 }); a.say({ t: 'hit', i: 7 });
await sleep(150);
assert.deepEqual(b.last('pos'), { t: 'pos', id: 1, x: 1.5, z: 42, s: 12, a: 0, d: 10, st: 0.2, r: 0 }); assert.equal(b.last('wheel').w, 1001); assert.equal(b.last('hit').i, 7); assert.equal(a.count('pos'), 0);
step('positions, roue et chocs relayes entre instances');

// 4. reconnexion sur une AUTRE instance avec le meme jeton : meme pilote, meme place
b.close(); await sleep(150); assert.equal(a.last('state').players[1].on, false);
const b2 = new FakeWS(); A.onConnection(b2, 'TEST'); b2.say({ t: 'join', token: 'tok-b', name: 'Hugo', cfg }); await sleep(200);
assert.equal(b2.last('welcome').id, 2); assert.equal(b2.last('welcome').resumed, true); assert.equal(b2.last('state').phase, 'race'); assert.equal(a.last('state').players[1].on, true);
step('reconnexion sur une autre instance : identite conservee');

// 5. arrivees puis classement, declenche par l'horloge d'une instance
a.say({ t: 'finish', time: 61.2, score: 900, hits: 3 }); await sleep(120);
assert.equal(b2.last('finished').id, 1); assert.ok(a.last('state').endAt > Date.now());
b2.say({ t: 'finish', time: 58.9, score: 1200, hits: 1 }); await sleep(150);
assert.ok(a.last('state').endAt - Date.now() < 6500, 'tous arrives : classement dans 6 s');
// on avance l'echeance pour ne pas attendre 6 s
const r = new RedisMock(); const st = JSON.parse(await r.get('gd:room:TEST')); st.endAt = Date.now() - 1; await r.set('gd:room:TEST', JSON.stringify(st));
for (const room of A._rooms.values()) room.snap.endAt = Date.now() - 1;
await A._tick(); await sleep(150);
const res = a.last('state'); assert.equal(res.phase, 'results'); assert.deepEqual(res.results.map((x) => x.name), ['Hugo', 'Martin']); assert.equal(res.results[0].score, 1200);
step('classement trie par temps avec les points');

// 6. retour a la grille, partie pleine, nettoyage
a.say({ t: 'lobby' }); await sleep(120); assert.equal(b2.last('state').phase, 'lobby');
const extra = []; for (let i = 0; i < 3; i++) { const w = new FakeWS(); (i % 2 ? A : B).onConnection(w, 'TEST'); w.say({ t: 'join', token: 'x' + i, name: 'P' + i }); extra.push(w); await sleep(120); }
assert.equal(a.last('state').players.length, 4); assert.ok(extra[2].last('full'), 'le 5e joueur est refuse');
step('partie limitee a 4 pilotes');
const bad = new FakeWS(); A.onConnection(bad, 'a b'); assert.ok(bad.last('badroom'));
for (const w of [a, b2, ...extra]) w.close(); await sleep(300);
assert.equal(A._rooms.size, 0); assert.equal(B._rooms.size, 0);
step('salons liberes cote instances quand tout le monde part');

console.log('\n' + ok + ' verifications reussies.');
process.exit(0);
