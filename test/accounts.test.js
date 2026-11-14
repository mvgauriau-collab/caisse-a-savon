// Comptes pilotes et circuits : inscription, connexion, credit des courses, choix du theme.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import RedisMock from 'ioredis-mock';
import { createGame } from '../lib/game.js';
import { createAccounts } from '../lib/accounts.js';
import { RedisStore } from '../lib/store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class FakeWS extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.inbox = []; }
  send(d) { this.inbox.push(JSON.parse(d)); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
  say(m) { this.emit('message', Buffer.from(JSON.stringify(m))); }
  last(t) { for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i].t === t) return this.inbox[i]; return null; }
}
const store = new RedisStore(new RedisMock()), acc = createAccounts(store), G = createGame(store, { accounts: acc });
let ok = 0; const step = (n) => { ok++; console.log('  ok  ' + n); };

// inscription et connexion
assert.equal((await acc.signup('ab', '1234')).err, 'pseudo'); assert.equal((await acc.signup('Martin', '12')).err, 'code');
const s1 = await acc.signup('Martin', '4242'); assert.ok(s1.ok && /^[a-f0-9]{48}$/.test(s1.session)); assert.equal(s1.account.races, 0);
assert.equal((await acc.signup('martin', '9999')).err, 'pris', 'pseudo unique sans tenir compte de la casse');
assert.equal((await acc.login('MARTIN', '0000')).err, 'ident'); const l1 = await acc.login('martin', '4242'); assert.ok(l1.ok); assert.equal(l1.account.pseudo, 'Martin');
const raw = JSON.parse(await new RedisMock().get('gd:acct:martin')); assert.ok(!JSON.stringify(raw).includes('4242'), 'le code secret n\'est pas stocke en clair');
step('inscription, connexion, code jamais stocke en clair');
for (let i = 0; i < 9; i++) await acc.login('martin', 'faux'); assert.equal((await acc.login('martin', '4242')).err, 'bloque'); await new RedisMock().del('gd:try:martin');
step('blocage temporaire apres trop d\'essais');
const cfg = { b: 4, w: 1, p: 2, a: 3, c: '#3ddc84', h: '#2b2f3a' }; assert.ok((await acc.setCfg(s1.session, cfg)).ok); assert.deepEqual((await acc.me(s1.session)).account.cfg, cfg);
assert.equal((await acc.me('x'.repeat(48))).ok, false);
step('caisse sauvegardee sur le compte');

// une course a 3 : deux comptes et un invite
const s2 = await acc.signup('Hugo', 'abcd');
const a = new FakeWS(), b = new FakeWS(), c = new FakeWS();
G.onConnection(a, 'RACE'); a.say({ t: 'join', token: 'ta', name: 'Nimporte', session: s1.session }); await sleep(120);
G.onConnection(b, 'RACE'); b.say({ t: 'join', token: 'tb', name: 'Hugo', session: s2.session }); await sleep(120);
G.onConnection(c, 'RACE'); c.say({ t: 'join', token: 'tc', name: 'Invite' }); await sleep(120);
let st = a.last('state'); assert.equal(st.players[0].name, 'Martin', 'le nom du pilote est celui du compte'); assert.equal(st.players[0].acct, true); assert.equal(st.players[2].acct, false);
b.say({ t: 'theme', v: 'hiver' }); await sleep(100); assert.equal(a.last('state').theme, 'alea', 'seul l\'hote choisit le circuit');
a.say({ t: 'theme', v: 'hiver' }); await sleep(100); assert.equal(c.last('state').theme, 'hiver'); a.say({ t: 'theme', v: 'lune' }); await sleep(80); assert.equal(c.last('state').theme, 'hiver');
a.say({ t: 'start' }); await sleep(150); assert.equal(b.last('start').theme, 'hiver'); assert.equal(b.last('state').raceTheme, 'hiver');
step('circuit choisi par l\'hote et transmis au depart');
b.say({ t: 'finish', time: 55.5, score: 1400, hits: 0 }); await sleep(80); a.say({ t: 'finish', time: 60.1, score: 900, hits: 4 }); await sleep(80); c.say({ t: 'finish', time: 70, score: 300, hits: 9 }); await sleep(120);
const r = new RedisMock(); const room = JSON.parse(await r.get('gd:room:RACE')); room.endAt = Date.now() - 1; await r.set('gd:room:RACE', JSON.stringify(room));
for (const x of G._rooms.values()) x.snap.endAt = Date.now() - 1;
await G._tick(); await sleep(200);
st = a.last('state'); assert.equal(st.phase, 'results'); assert.deepEqual(st.results.map((x) => x.name), ['Hugo', 'Martin', 'Invite']);
const mh = (await acc.me(s2.session)).account, mm = (await acc.me(s1.session)).account;
assert.deepEqual([mh.races, mh.wins, mh.podiums, mh.xp], [1, 1, 1, 1400]); assert.deepEqual([mm.races, mm.wins, mm.podiums, mm.xp], [1, 0, 1, 900]);
assert.equal(mh.hist[0].r, 1); assert.equal(mh.hist[0].n, 3); assert.equal(mh.hist[0].th, 'hiver');
assert.equal(st.players[1].xp, 1400, 'la grille affiche l\'experience a jour');
step('course creditee : victoire, podium, experience, historique');
await G._tick(); await sleep(100); assert.equal((await acc.me(s2.session)).account.races, 1, 'une course n\'est creditee qu\'une fois');
step('pas de double credit');
// le dernier n'est pas sur le podium, un pilote seul ne gagne rien
await acc.credit({ key: 'martin', rank: 1, n: 2, score: 100, time: 50, theme: 'desert' }); await acc.credit({ key: 'martin', rank: 0, n: 1, score: 100, time: 50, theme: 'desert' });
const m2 = (await acc.me(s1.session)).account; assert.deepEqual([m2.races, m2.wins, m2.podiums], [3, 0, 1]); assert.equal(m2.hist.length, 3);
step('regles du podium : jamais le dernier, jamais en solo');
// pays du pilote
const s3 = await acc.signup('Lena', 'zzzz', 'de'); assert.equal(s3.account.pays, 'DE'); assert.equal((await acc.signup('Bad', 'zzzz', 'France')).account.pays, '');
assert.equal((await acc.setPays(s1.session, 'fr')).account.pays, 'FR');
step('pays enregistre sur le compte');

// course avec bots : classee, mais creditee sur aucun compte
for (const w of [a, b, c]) w.close(); await sleep(250);
const h = new FakeWS(), g = new FakeWS();
G.onConnection(h, 'BOTS'); h.say({ t: 'join', token: 'th', session: s1.session }); await sleep(120);
G.onConnection(g, 'BOTS'); g.say({ t: 'join', token: 'tg', session: s3.session }); await sleep(120);
assert.equal(h.last('state').players[0].pays, 'FR'); assert.equal(h.last('state').players[1].pays, 'DE');
g.say({ t: 'bots', v: 3 }); await sleep(80); assert.equal(h.last('state').bots, 0, 'seul l\'hote regle les bots');
h.say({ t: 'bots', v: 3 }); await sleep(80); assert.equal(g.last('state').bots, 3);
h.say({ t: 'start' }); await sleep(150);
const bots = g.last('start').bots; assert.equal(bots.length, 3, 'les bots ne prennent que les places libres'); assert.deepEqual(bots.map((x) => x.id), [-1, -2, -3]); assert.deepEqual(bots.map((x) => x.slot), [2, 3, 4]);
g.say({ t: 'bpos', b: -1, x: 1, z: 30, s: 9 }); await sleep(60); assert.equal(h.last('pos'), null, 'seul l\'hote pilote les bots');
h.say({ t: 'bpos', b: -1, x: 1, z: 30, s: 9, a: 0, d: 5, st: 0 }); h.say({ t: 'bpos', b: -9, x: 1, z: 30, s: 9 }); await sleep(60); assert.deepEqual(g.last('pos'), { t: 'pos', id: -1, x: 1, z: 30, s: 9, a: 0, d: 5, st: 0 });
h.say({ t: 'bfinish', b: -1, time: 50 }); await sleep(80); assert.equal(g.last('finished').id, -1);
h.say({ t: 'finish', time: 52, score: 800, hits: 1 }); g.say({ t: 'finish', time: 49, score: 950, hits: 0 }); await sleep(200);
const before = (await acc.me(s1.session)).account.races;
const r2 = new RedisMock(); const rm = JSON.parse(await r2.get('gd:room:BOTS')); rm.endAt = Date.now() - 1; await r2.set('gd:room:BOTS', JSON.stringify(rm));
for (const x of G._rooms.values()) x.snap.endAt = Date.now() - 1;
await G._tick(); await sleep(200);
const rs = h.last('state').results; assert.deepEqual(rs.map((x) => x.name.startsWith('Bot') ? 'bot' : x.name), ['Lena', 'bot', 'Martin', 'bot', 'bot']); assert.equal(rs[1].bot, true); assert.equal(rs[3].time, null);
assert.equal((await acc.me(s1.session)).account.races, before, 'aucun credit avec des bots'); assert.equal((await acc.me(s3.session)).account.races, 0);
step('bots : classes, pilotes par l\'hote, course non creditee');
// classement general
const t1 = await acc.top('xp', s1.session); assert.deepEqual(t1.top.slice(0, 2).map((x) => x.pseudo), ['Hugo', 'Martin']); assert.equal(t1.me.rank, 2); assert.equal(t1.top[1].pays, 'FR');
const t2 = await acc.top('podiums'); assert.ok(t2.top.length >= 3); assert.equal(t2.me, null); assert.equal((await acc.top('nimporte')).by, 'xp');
assert.ok(!JSON.stringify(t1).includes('hash') && !JSON.stringify(t1).includes('salt'), 'aucune donnee secrete dans le classement');
step('classement general par experience, victoires ou podiums');

// abandon et depart de la partie
h.say({ t: 'lobby' }); await sleep(100); h.say({ t: 'bots', v: 0 }); await sleep(80); h.say({ t: 'start' }); await sleep(150);
g.say({ t: 'quit' }); await sleep(120); assert.deepEqual(h.last('state').racers, [1]); assert.equal(h.last('left').id, 2); assert.equal(h.last('state').players.length, 2, 'abandonner laisse le joueur dans la partie');
h.say({ t: 'quit' }); await sleep(120); assert.equal(g.last('state').phase, 'lobby', 'plus personne en course : retour a la grille');
g.say({ t: 'leave' }); await sleep(150); assert.equal(h.last('state').players.length, 1); assert.equal(g.readyState, 3);
step('abandon de course et depart immediat de la partie');
await acc.logout(s1.session); assert.equal((await acc.me(s1.session)).ok, false);
step('deconnexion');
console.log('\n' + ok + ' verifications reussies.'); process.exit(0);
