// Comptes pilotes : pseudo + code secret. Le code n'est jamais stocke, seulement son empreinte (scrypt).
// Chaque compte garde son experience, son nombre de courses, victoires, podiums et ses dernieres courses.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL = 90 * 86400;      // 90 jours
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAccounts(store) {
  const AK = (k) => 'gd:acct:' + k, SK = (t) => 'gd:sess:' + t, TK = (k) => 'gd:try:' + k, LK = (k) => 'gd:alock:' + k;
  const keyOf = (p) => String(p || '').trim().toLowerCase();
  const validPseudo = (p) => /^[A-Za-z0-9À-ÖØ-öø-ÿ_-]{3,14}$/.test(p);
  const hash = (code, salt) => scryptSync(String(code), salt, 32).toString('hex');
  // Caisses : une par niveau atteint (niveau 2, 3, ...). Aux niveaux multiples de 10, la caisse contient un gros lot.
  // Le tirage se fait ici, cote serveur, parmi les objets que le pilote n'a pas encore.
  const levelOf = (xp) => Math.floor(Math.sqrt((xp || 0) / 800)) + 1;
  const LOOT = { commun: ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'], rare: ['w1', 'w3', 'p1', 'p2', 'p3', 'a2', 'a3', 'a4'], epique: ['b1', 'b2', 'b4'], gros: ['b5', 'b6'] };
  const POIDS = { commun: 55, rare: 35, epique: 10 };
  function draw(inv, big) {
    const has = new Set(inv), left = (r) => LOOT[r].filter((id) => !has.has(id));
    if (big && left('gros').length) { const l = left('gros'); return { id: l[Math.floor(Math.random() * l.length)], rar: 'gros' }; }
    const rs = (big ? ['epique', 'rare', 'commun'] : ['commun', 'rare', 'epique']).filter((r) => left(r).length); if (!rs.length) return null;
    let r = rs[0];
    if (!big) { let t = rs.reduce((s, x) => s + POIDS[x], 0) * Math.random(); for (const x of rs) { t -= POIDS[x]; if (t <= 0) { r = x; break; } } }
    const l = left(r); return { id: l[Math.floor(Math.random() * l.length)], rar: r };
  }
  async function crate(tok) {
    const a0 = await bySession(tok); if (!a0) return { ok: false, err: 'session' };
    return withLock(a0.key, async () => {
      const a = await load(a0.key); if (!a) return { ok: false, err: 'session' };
      a.inv = a.inv || []; a.opened = a.opened || 0;
      if (a.opened >= levelOf(a.xp) - 1) return { ok: false, err: 'aucune', account: pub(a) };
      const big = (a.opened + 2) % 10 === 0, d = draw(a.inv, big);
      if (!d) return { ok: false, err: 'complet', account: pub(a) };
      a.inv.push(d.id); a.opened++; await save(a);
      return { ok: true, item: d.id, rar: d.rar, big, account: pub(a) };
    });
  }
  const pub = (a) => ({ inv: a.inv || [], opened: a.opened || 0, pseudo: a.pseudo, xp: a.xp || 0, races: a.races || 0, wins: a.wins || 0, podiums: a.podiums || 0, cfg: a.cfg || null, hist: a.hist || [], pays: a.pays || '' });
  const cleanPays = (v) => { v = String(v || '').toUpperCase(); return /^[A-Z]{2}$/.test(v) ? v : ''; };

  // Classement general : un ensemble trie par critere, plus une fiche resumee par pilote.
  const BOARDS = { xp: 'gd:lb:xp', wins: 'gd:lb:wins', podiums: 'gd:lb:podiums' };
  async function board(a) {
    try {
      await store.zadd(BOARDS.xp, a.xp || 0, a.key); await store.zadd(BOARDS.wins, a.wins || 0, a.key); await store.zadd(BOARDS.podiums, a.podiums || 0, a.key);
      await store.hset('gd:lbinfo', a.key, JSON.stringify({ pseudo: a.pseudo, pays: a.pays || '', xp: a.xp || 0, races: a.races || 0, wins: a.wins || 0, podiums: a.podiums || 0 }));
    } catch (e) { console.error('[classement]', e.message); }
  }
  async function top(by, tok) {
    const k = BOARDS[by] || BOARDS.xp; const rows = await store.ztop(k, 50);
    const infos = await store.hmget('gd:lbinfo', rows.map((r) => r[0]));
    const list = []; rows.forEach((r, i) => { try { const o = JSON.parse(infos[i]); if (o) list.push(o); } catch (_) {} });
    let me = null; const a = tok ? await bySession(tok) : null;
    if (a) { const rk = await store.zrank(k, a.key); if (rk != null) me = { rank: rk + 1, pseudo: a.pseudo }; }
    return { ok: true, by: BOARDS[by] ? by : 'xp', top: list, me };
  }
  async function load(key) { const raw = await store.get(AK(key)); return raw ? JSON.parse(raw) : null; }
  async function save(a) { await store.set(AK(a.key), JSON.stringify(a), 0); }
  async function withLock(key, fn) {
    const tok = Math.random().toString(36).slice(2); let got = false;
    for (let i = 0; i < 80 && !got; i++) { got = await store.lock(LK(key), tok, 3000); if (!got) await sleep(10 + Math.random() * 30); }
    if (!got) throw new Error('verrou compte');
    try { return await fn(); } finally { await store.unlock(LK(key), tok).catch(() => {}); }
  }
  async function newSession(key) { const t = randomBytes(24).toString('hex'); await store.set(SK(t), key, SESSION_TTL); return t; }

  async function signup(pseudo, code, pays) {
    pseudo = String(pseudo || '').trim(); code = String(code || '');
    if (!validPseudo(pseudo)) return { ok: false, err: 'pseudo' };
    if (code.length < 4 || code.length > 40) return { ok: false, err: 'code' };
    const key = keyOf(pseudo);
    return withLock(key, async () => {
      if (await load(key)) return { ok: false, err: 'pris' };
      const salt = randomBytes(16).toString('hex');
      const a = { key, pseudo, salt, hash: hash(code, salt), xp: 0, races: 0, wins: 0, podiums: 0, cfg: null, hist: [], pays: cleanPays(pays), created: Date.now() };
      await save(a); await board(a); return { ok: true, session: await newSession(key), account: pub(a) };
    });
  }
  async function login(pseudo, code) {
    const key = keyOf(pseudo); if (!key) return { ok: false, err: 'ident' };
    const tries = Number(await store.get(TK(key))) || 0;
    if (tries >= 8) return { ok: false, err: 'bloque' };
    const a = await load(key); let good = false;
    if (a) { const h = Buffer.from(hash(String(code || ''), a.salt), 'hex'), ref = Buffer.from(a.hash, 'hex'); good = h.length === ref.length && timingSafeEqual(h, ref); }
    if (!good) { await store.set(TK(key), String(tries + 1), 600); return { ok: false, err: 'ident' }; }
    await store.del(TK(key)); await board(a);
    return { ok: true, session: await newSession(key), account: pub(a) };
  }
  async function bySession(tok) {
    if (!/^[a-f0-9]{48}$/.test(String(tok || ''))) return null;
    const key = await store.get(SK(tok)); if (!key) return null;
    return load(key);
  }
  async function me(tok) { const a = await bySession(tok); return a ? { ok: true, account: pub(a) } : { ok: false, err: 'session' }; }
  async function logout(tok) { if (/^[a-f0-9]{48}$/.test(String(tok || ''))) await store.del(SK(tok)); return { ok: true }; }
  async function setCfg(tok, cfg) {
    const a0 = await bySession(tok); if (!a0) return { ok: false, err: 'session' };
    if (!cfg || typeof cfg !== 'object') return { ok: false, err: 'cfg' };
    const c = {}; for (const k of ['b', 'w', 'p', 'a']) { const v = cfg[k]; c[k] = Number.isFinite(v) && v >= 0 && v < 20 ? Math.floor(v) : 0; }
    for (const k of ['c', 'h']) { const v = String(cfg[k] || ''); c[k] = /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#ff5a4d'; }
    return withLock(a0.key, async () => { const a = await load(a0.key); if (!a) return { ok: false, err: 'session' }; a.cfg = c; await save(a); return { ok: true }; });
  }
  async function setPays(tok, pays) {
    const a0 = await bySession(tok); if (!a0) return { ok: false, err: 'session' };
    return withLock(a0.key, async () => { const a = await load(a0.key); if (!a) return { ok: false, err: 'session' }; a.pays = cleanPays(pays); await save(a); await board(a); return { ok: true, account: pub(a) }; });
  }
  // Enregistre une course terminee. rank : 0 pour le premier ; n : nombre de pilotes classes.
  // Victoire et podium ne comptent qu'a partir de 2 pilotes ; le dernier n'est jamais sur le podium.
  async function credit({ key, rank, n, score, time, theme }) {
    return withLock(key, async () => {
      const a = await load(key); if (!a) return null;
      a.races = (a.races || 0) + 1; a.xp = (a.xp || 0) + Math.max(0, Math.min(20000, Math.floor(score || 0)));
      const win = n >= 2 && rank === 0, podium = n >= 2 && rank < Math.min(3, n - 1);
      if (win) a.wins = (a.wins || 0) + 1; if (podium) a.podiums = (a.podiums || 0) + 1;
      a.hist = [{ d: Date.now(), r: rank + 1, n, t: Math.round((time || 0) * 100) / 100, th: theme || '', s: Math.floor(score || 0) }].concat(a.hist || []).slice(0, 10);
      await save(a); await board(a); return pub(a);
    });
  }
  return { signup, login, me, logout, setCfg, setPays, bySession, credit, top, crate };
}
