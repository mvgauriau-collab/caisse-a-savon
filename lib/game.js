// Logique des parties, independante du transport et de l'hebergeur.
// Chaque partie (nom de salle de 2 a 16 caracteres) a son etat dans le store partage et un canal pub/sub.
// Une instance ne garde en memoire que ses propres sockets : tout le reste vit dans le store.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TTL = 7200;            // duree de vie d'une partie inactive, en secondes
const GRACE = 20000;         // delai laisse a un joueur deconnecte pour revenir
const STALE = 45000;         // joueur d'une autre instance sans signe de vie
const HEARTBEAT = 15000;
const FINISH_TIMEOUT = 30000;
const RESULTS_DELAY = 6000;
const MAX_PLAYERS = 4;
const THEMES = ['campagne', 'desert', 'hiver'];
const BOT_NAMES = ['Gaston', 'Lulu', 'Momo', 'Zaza', 'Bibi', 'Titi', 'Nono', 'Jojo', 'Fifi', 'Riri'];
const BOT_COLORS = ['#ff5a4d', '#ff8c1a', '#ffc93c', '#3ddc84', '#29a8ff', '#3b4cca', '#9b5de5', '#ff77a8'];
const BPOS = ['x', 'z', 's', 'a', 'd', 'st'];
const rint = (n) => Math.floor(Math.random() * n);
const RELAY = { pos: ['x', 'z', 's', 'a', 'd', 'st', 'r'], hit: ['i'], box: ['i'], wheel: ['w', 'z', 'x', 's', 'i'], whit: ['w', 'o'] };

export function createGame(store, opt = {}) {
  const inst = Math.random().toString(36).slice(2, 10);
  const accounts = opt.accounts || null;
  const rooms = new Map();   // code -> { socks: Map(id -> ws), snap, allLocal, hb, busy }
  const K = (c) => 'gd:room:' + c, CH = (c) => 'gd:ch:' + c, LK = (c) => 'gd:lock:' + c;
  let timer = null;

  const view = (st) => ({
    t: 'state', room: st.code, phase: st.phase, host: st.host,
    players: Object.values(st.players).sort((a, b) => a.slot - b.slot)
      .map((p) => ({ id: p.id, name: p.name, color: p.color, cfg: p.cfg, slot: p.slot, on: p.on, inst: p.inst, offAt: p.offAt, acct: !!p.acct, xp: p.xp || 0, pays: p.pays || '' })),
    bots: st.bots || 0, raceBots: st.raceBots || [],
    theme: st.theme || 'alea', raceTheme: st.raceTheme || 'campagne',
    results: st.results, racers: st.racers, seed: st.seed, startedAt: st.startedAt, endAt: st.endAt, raceId: st.raceId, now: Date.now(),
  });

  function deliver(code, msg, exceptId) {
    const room = rooms.get(code); if (!room) return;
    if (msg.t === 'state') { room.snap = msg; room.allLocal = msg.players.every((p) => !p.on || p.inst === inst); }
    const data = JSON.stringify(msg);
    for (const [id, ws] of room.socks) { if (id === exceptId) continue; if (ws.readyState === 1) { try { ws.send(data); } catch (_) {} } }
  }
  // volatile : positions et autres messages a haute frequence. Si tous les joueurs sont
  // sur cette instance, on ne passe pas par Redis du tout.
  function emit(code, msg, exceptId, volatile) {
    deliver(code, msg, exceptId);
    const room = rooms.get(code);
    if (volatile && room && room.allLocal) return Promise.resolve();
    return store.publish(CH(code), JSON.stringify({ src: inst, ex: exceptId == null ? null : exceptId, m: msg })).catch((e) => console.error('[publish]', e.message));
  }
  function onChannel(code, raw) { let e; try { e = JSON.parse(raw); } catch (_) { return; } if (e.src === inst) return; deliver(code, e.m, e.ex); }

  async function mutate(code, fn) {
    const tok = inst + ':' + Math.random().toString(36).slice(2);
    let got = false;
    for (let i = 0; i < 80 && !got; i++) { got = await store.lock(LK(code), tok, 3000); if (!got) await sleep(10 + Math.random() * 30); }
    if (!got) throw new Error('verrou indisponible pour ' + code);
    try {
      const raw = await store.get(K(code)); const st = raw ? JSON.parse(raw) : null;
      const out = fn(st); if (!out) return null;
      if (out.state === null) await store.del(K(code)); else await store.set(K(code), JSON.stringify(out.state), TTL);
      for (const ev of out.events || []) await emit(code, ev, null, false);
      return out;
    } finally { await store.unlock(LK(code), tok).catch(() => {}); }
  }

  async function ensureRoom(code) {
    let room = rooms.get(code);
    if (!room) { room = { socks: new Map(), snap: null, allLocal: false, hb: Date.now(), busy: false }; rooms.set(code, room); await store.subscribe(CH(code), (raw) => onChannel(code, raw)); }
    if (!timer) { timer = setInterval(() => tick().catch((e) => console.error('[tick]', e.message)), 1000); if (timer.unref) timer.unref(); }
    return room;
  }
  async function dropRoomIfEmpty(code) { const room = rooms.get(code); if (room && room.socks.size === 0) { rooms.delete(code); await store.unsubscribe(CH(code)).catch(() => {}); } }

  function setProfile(p, m) {
    const name = String(m.name == null ? '' : m.name).replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 14);
    if (name) p.name = name; else if (!p.name) p.name = 'Pilote ' + (p.slot + 1);
    if (m.cfg && typeof m.cfg === 'object') {
      const c = {}; for (const k of ['b', 'w', 'p', 'a']) { const v = m.cfg[k]; c[k] = Number.isFinite(v) && v >= 0 && v < 20 ? Math.floor(v) : 0; }
      for (const k of ['c', 'h']) { const v = String(m.cfg[k] || ''); c[k] = /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#ff5a4d'; }
      p.cfg = c; p.color = c.c;
    }
  }
  // retire les joueurs partis pour de bon ; renvoie les ids retires
  function purge(st, now, localIds) {
    const gone = [];
    for (const p of Object.values(st.players)) {
      if (localIds && localIds.has(p.id)) { p.seenAt = now; continue; }
      if ((!p.on && now - (p.offAt || 0) > GRACE) || (p.on && now - (p.seenAt || 0) > STALE)) { delete st.players[p.id]; gone.push(p.id); }
    }
    if (gone.length) {
      const left = Object.values(st.players).sort((a, b) => a.slot - b.slot);
      if (st.host == null || !st.players[st.host]) st.host = left.length ? left[0].id : null;
      if (st.phase === 'race') checkAllFinished(st, now);
    }
    return gone;
  }
  function checkAllFinished(st, now) {
    const present = st.racers.filter((id) => st.players[id]);
    if (present.every((id) => st.finished[id] != null)) st.endAt = Math.min(st.endAt || Infinity, now + (present.length ? RESULTS_DELAY : 0));
  }
  function endRace(st) {
    const done = Object.entries(st.finished).sort((a, b) => a[1] - b[1]); const res = [];
    for (const [id, t] of done) { const p = st.players[id]; if (p) { const e = st.extra[id] || {}; res.push({ id: p.id, name: p.name, time: t, score: e.score || 0, hits: e.hits || 0 }); } }
    const bots = st.raceBots || [], bf = st.botFinished || {};
    for (const b of bots) if (bf[b.id] != null) res.push({ id: b.id, name: b.name, time: bf[b.id], score: 0, hits: 0, bot: true });
    res.sort((a, b) => a.time - b.time);
    for (const id of st.racers) { const p = st.players[id]; if (p && st.finished[id] == null) res.push({ id: p.id, name: p.name, time: null, score: 0, hits: 0 }); }
    for (const b of bots) if (bf[b.id] == null) res.push({ id: b.id, name: b.name, time: null, score: 0, hits: 0, bot: true });
    st.results = res; st.phase = 'results'; st.endAt = null;
    // courses a crediter sur les comptes : uniquement les pilotes arrives
    const n = res.length, credits = [];
    if (bots.length) return credits;   // une course avec des bots n'est creditee sur aucun compte
    res.forEach((r, i) => { const p = st.players[r.id]; if (p && p.acct && r.time != null) credits.push({ id: p.id, key: p.acct, rank: i, n, score: r.score, time: r.time, theme: st.raceTheme }); });
    return credits;
  }
  const send = (ws, m) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(m)); } catch (_) {} } };

  async function join(ctx, m) {
    const tok = String(m.token || '').slice(0, 48) || Math.random().toString(36).slice(2);
    const room = await ensureRoom(ctx.code); let reply = null;
    const acct = accounts && m.session ? await accounts.bySession(m.session).catch(() => null) : null;
    const out = await mutate(ctx.code, (st) => {
      const now = Date.now();
      if (!st) st = { code: ctx.code, phase: 'lobby', theme: 'alea', raceTheme: 'campagne', host: null, nextId: 1, players: {}, racers: [], finished: {}, extra: {}, results: [], raceId: 0, seed: 0, startedAt: 0, endAt: null };
      const gone = purge(st, now, null);
      let p = Object.values(st.players).find((q) => q.token === tok); const resumed = !!p;
      if (!p) {
        if (Object.keys(st.players).length >= MAX_PLAYERS) { reply = { t: 'full' }; return gone.length ? { state: st, events: gone.map((id) => ({ t: 'left', id })).concat([view(st)]) } : null; }
        const used = new Set(Object.values(st.players).map((q) => q.slot)); let slot = 0; while (used.has(slot)) slot++;
        p = { id: st.nextId++, slot, token: tok, name: '', color: '#ff5a4d', cfg: {} }; st.players[p.id] = p;
      }
      setProfile(p, m); p.on = true; p.inst = inst; p.seenAt = now; p.offAt = 0;
      if (acct) { p.acct = acct.key; p.name = acct.pseudo; p.xp = acct.xp || 0; p.pays = acct.pays || ''; } else { delete p.acct; p.xp = 0; p.pays = ''; }
      if (st.host == null || !st.players[st.host]) st.host = p.id;
      reply = { t: 'welcome', id: p.id, room: st.code, resumed };
      return { state: st, events: gone.map((id) => ({ t: 'left', id })).concat([view(st)]) };
    });
    if (!reply || reply.t === 'full') { send(ctx.ws, { t: 'full' }); await dropRoomIfEmpty(ctx.code); return; }
    const old = room.socks.get(reply.id); if (old && old !== ctx.ws) { try { old.close(); } catch (_) {} }
    ctx.id = reply.id; room.socks.set(ctx.id, ctx.ws);
    send(ctx.ws, reply); const v = view(out.state); room.snap = v; room.allLocal = v.players.every((p) => !p.on || p.inst === inst); send(ctx.ws, v);
  }

  async function handle(ctx, m) {
    const t = m.t;
    if (t === 'join') { if (ctx.id == null) await join(ctx, m); return; }
    if (ctx.id == null) return;
    const room = rooms.get(ctx.code); if (!room) return;
    if (t === 'bpos') {   // positions des bots, simulees par l'hote
      if (!room.snap || room.snap.phase !== 'race' || room.snap.host !== ctx.id) return;
      const b = m.b; if (!(room.snap.raceBots || []).some((q) => q.id === b)) return;
      const out = { t: 'pos', id: b }; for (const k of BPOS) { const v = m[k]; out[k] = typeof v === 'number' && Number.isFinite(v) ? v : 0; }
      emit(ctx.code, out, ctx.id, true); return;
    }
    if (RELAY[t]) {
      if (!room.snap || room.snap.phase !== 'race') return;
      const out = { t, id: ctx.id }; for (const k of RELAY[t]) { const v = m[k]; if (typeof v === 'number' && Number.isFinite(v)) out[k] = v; else if (t === 'pos') out[k] = 0; }
      emit(ctx.code, out, ctx.id, true); return;
    }
    if (t === 'car') {
      await mutate(ctx.code, (st) => { const p = st && st.players[ctx.id]; if (!p) return null; const nm = p.name; setProfile(p, m); if (p.acct) p.name = nm; return { state: st, events: [view(st)] }; });
    } else if (t === 'leave') {   // quitter la partie tout de suite, sans attendre le delai de grace
      const id = ctx.id; room.socks.delete(id); ctx.id = null;
      await mutate(ctx.code, (st) => {
        if (!st || !st.players[id]) return null; delete st.players[id];
        const left = Object.values(st.players).sort((a, b) => a.slot - b.slot);
        if (!left.length) return { state: null, events: [] };
        if (st.host === id || !st.players[st.host]) st.host = left[0].id;
        if (st.phase === 'race') { if (!st.racers.some((r) => st.players[r])) { st.phase = 'lobby'; st.endAt = null; } else checkAllFinished(st, Date.now()); }
        return { state: st, events: [{ t: 'left', id }, view(st)] };
      });
      try { ctx.ws.close(); } catch (_) {}
      await dropRoomIfEmpty(ctx.code);
    } else if (t === 'quit') {    // abandonner la course en restant dans la partie
      await mutate(ctx.code, (st) => {
        if (!st || st.phase !== 'race' || !st.racers.includes(ctx.id) || st.finished[ctx.id] != null) return null;
        st.racers = st.racers.filter((r) => r !== ctx.id);
        if (!st.racers.some((r) => st.players[r])) { st.phase = 'lobby'; st.endAt = null; } else checkAllFinished(st, Date.now());
        return { state: st, events: [{ t: 'left', id: ctx.id }, view(st)] };
      });
    } else if (t === 'bots') {
      const v = Math.max(0, Math.min(MAX_PLAYERS - 1, Math.floor(Number(m.v) || 0)));
      await mutate(ctx.code, (st) => { if (!st || st.host !== ctx.id || st.phase === 'race') return null; st.bots = v; return { state: st, events: [view(st)] }; });
    } else if (t === 'bfinish') {
      await mutate(ctx.code, (st) => {
        if (!st || st.phase !== 'race' || st.host !== ctx.id) return null; const b = (st.raceBots || []).find((q) => q.id === m.b); if (!b) return null;
        st.botFinished = st.botFinished || {}; if (st.botFinished[b.id] != null) return null;
        const time = Math.max(0, Number(m.time) || 0); st.botFinished[b.id] = time;
        return { state: st, events: [{ t: 'finished', id: b.id, time, rank: 0 }] };
      });
    } else if (t === 'theme') {
      const v = m.v === 'alea' || THEMES.includes(m.v) ? m.v : null; if (!v) return;
      await mutate(ctx.code, (st) => { if (!st || st.host !== ctx.id || st.phase === 'race') return null; st.theme = v; return { state: st, events: [view(st)] }; });
    } else if (t === 'start') {
      await mutate(ctx.code, (st) => {
        if (!st || st.host !== ctx.id || st.phase === 'race') return null;
        const now = Date.now(); st.raceId++; st.phase = 'race'; st.finished = {}; st.extra = {}; st.results = []; st.endAt = null; st.startedAt = now;
        st.racers = Object.values(st.players).filter((p) => p.on).sort((a, b) => a.slot - b.slot).map((p) => p.id);
        st.seed = 1 + Math.floor(Math.random() * 2147483646);
        st.raceTheme = THEMES.includes(st.theme) ? st.theme : THEMES[Math.floor(Math.random() * THEMES.length)];
        // bots : ils prennent les places libres, avec un nom et une caisse tires au hasard
        const used = new Set(st.racers.map((id) => st.players[id].slot)), free = [0, 1, 2, 3].filter((x) => !used.has(x));
        const nb = Math.min(st.bots || 0, free.length), names = BOT_NAMES.slice().sort(() => Math.random() - .5);
        st.raceBots = []; st.botFinished = {};
        for (let i = 0; i < nb; i++) { const c = BOT_COLORS[rint(BOT_COLORS.length)]; st.raceBots.push({ id: -(i + 1), name: 'Bot ' + names[i], slot: free[i], color: c, cfg: { b: rint(5), w: rint(4), p: rint(5), a: rint(5), c, h: BOT_COLORS[rint(BOT_COLORS.length)] } }); }
        return { state: st, events: [view(st), { t: 'start', seed: st.seed, racers: st.racers, countdown: 4000, theme: st.raceTheme, bots: st.raceBots }] };
      });
    } else if (t === 'finish') {
      await mutate(ctx.code, (st) => {
        if (!st || st.phase !== 'race' || !st.racers.includes(ctx.id) || st.finished[ctx.id] != null) return null;
        const now = Date.now(); const time = Math.max(0, Number(m.time) || 0); const first = Object.keys(st.finished).length === 0;
        st.finished[ctx.id] = time; st.extra[ctx.id] = { score: Math.max(0, Math.floor(Number(m.score) || 0)), hits: Math.max(0, Math.floor(Number(m.hits) || 0)) };
        if (first) st.endAt = now + FINISH_TIMEOUT; checkAllFinished(st, now);
        return { state: st, events: [{ t: 'finished', id: ctx.id, time, rank: Object.keys(st.finished).length }, view(st)] };
      });
    } else if (t === 'lobby') {
      await mutate(ctx.code, (st) => { if (!st || st.host !== ctx.id || st.phase !== 'results') return null; st.phase = 'lobby'; return { state: st, events: [view(st)] }; });
    }
  }

  async function leave(ctx) {
    const room = rooms.get(ctx.code); if (!room) return;
    if (ctx.id != null && room.socks.get(ctx.id) === ctx.ws) {
      room.socks.delete(ctx.id);
      await mutate(ctx.code, (st) => { const p = st && st.players[ctx.id]; if (!p || p.inst !== inst) return null; p.on = false; p.offAt = Date.now(); return { state: st, events: [view(st)] }; }).catch((e) => console.error('[leave]', e.message));
    }
    await dropRoomIfEmpty(ctx.code);
  }

  async function tick() {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const s = room.snap; if (!s || room.busy) continue;
      const mustEnd = s.phase === 'race' && s.endAt && now >= s.endAt;
      const mustClean = s.players.some((p) => !p.on && now - (p.offAt || 0) > GRACE);
      if (!mustEnd && !mustClean && now - room.hb < HEARTBEAT) continue;
      room.busy = true; room.hb = now; let credits = [];
      try {
        await mutate(code, (st) => {
          if (!st) return null; const t = Date.now(); const events = [];
          const gone = purge(st, t, new Set(room.socks.keys()));
          for (const id of gone) events.push({ t: 'left', id });
          if (Object.keys(st.players).length === 0) return { state: null, events };
          let changed = gone.length > 0;
          if (st.phase === 'race' && st.endAt && t >= st.endAt) { credits = endRace(st); changed = true; }
          if (changed) events.push(view(st));
          return { state: st, events };
        });
        // les comptes sont credites une seule fois, par l'instance qui a clos la course
        if (accounts && credits.length) {
          const fresh = {};
          for (const c of credits) { try { const a = await accounts.credit(c); if (a) fresh[c.id] = a.xp; } catch (e) { console.error('[credit]', e.message); } }
          await mutate(code, (st) => { if (!st) return null; let ch = false; for (const id of Object.keys(fresh)) { const p = st.players[id]; if (p) { p.xp = fresh[id]; ch = true; } } return ch ? { state: st, events: [view(st)] } : null; });
        }
      } finally { room.busy = false; }
    }
  }

  function onConnection(ws, roomCode) {
    const code = String(roomCode || '').toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{0,14}[A-Z0-9]$/.test(code)) { send(ws, { t: 'badroom' }); try { ws.close(); } catch (_) {} return; }
    const ctx = { ws, code, id: null }; let chain = Promise.resolve();
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch (_) { return; }
      if (!m || typeof m !== 'object') return;
      // les messages d'un meme joueur sont traites dans l'ordre
      chain = chain.then(() => handle(ctx, m)).catch((e) => console.error('[message]', e.message));
    });
    ws.on('close', () => { chain = chain.then(() => leave(ctx)).catch((e) => console.error('[close]', e.message)); });
    ws.on('error', () => {});
  }

  return { onConnection, inst, _rooms: rooms, _tick: tick };
}
