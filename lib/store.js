// Stockage partage entre les instances de la fonction Vercel.
// - Avec REDIS_URL (Redis du Marketplace Vercel) : etat des parties + pub/sub dans Redis.
// - Sans REDIS_URL : tout reste en memoire. Suffisant en local, pas fiable en production,
//   car deux joueurs peuvent atterrir sur deux instances differentes.
import { EventEmitter } from 'node:events';

export class MemoryStore {
  constructor() { this.data = new Map(); this.bus = new EventEmitter(); this.bus.setMaxListeners(0); this.handlers = new Map(); this.shared = false; }
  async get(k) { return this.data.has(k) ? this.data.get(k) : null; }
  async set(k, v) { this.data.set(k, v); }
  async del(k) { this.data.delete(k); }
  async lock(k, tok) { if (this.data.has(k)) return false; this.data.set(k, tok); return true; }
  async unlock(k, tok) { if (this.data.get(k) === tok) this.data.delete(k); }
  async zadd(k, score, member) { let z = this.data.get(k); if (!z) { z = new Map(); this.data.set(k, z); } z.set(member, score); }
  async ztop(k, n) { const z = this.data.get(k); return z ? [...z.entries()].sort((a, b) => b[1] - a[1]).slice(0, n) : []; }
  async zrank(k, member) { const z = this.data.get(k); if (!z || !z.has(member)) return null; return [...z.entries()].sort((a, b) => b[1] - a[1]).findIndex((e) => e[0] === member); }
  async hset(k, f, v) { let h = this.data.get(k); if (!h) { h = new Map(); this.data.set(k, h); } h.set(f, v); }
  async hmget(k, fields) { const h = this.data.get(k); return fields.map((f) => (h && h.has(f) ? h.get(f) : null)); }
  async hkeys(k) { const h = this.data.get(k); return h ? [...h.keys()] : []; }
  async hdel(k, f) { const h = this.data.get(k); if (h) h.delete(f); }
  async publish(ch, msg) { this.bus.emit(ch, msg); }
  async subscribe(ch, fn) { this.handlers.set(ch, fn); this.bus.on(ch, fn); }
  async unsubscribe(ch) { const fn = this.handlers.get(ch); if (fn) { this.bus.off(ch, fn); this.handlers.delete(ch); } }
}

export class RedisStore {
  // client : une instance ioredis (ou compatible). Une seconde connexion sert aux abonnements.
  constructor(client) {
    this.r = client; this.sub = client.duplicate(); this.handlers = new Map(); this.shared = true;
    this.sub.on('message', (ch, msg) => { const fn = this.handlers.get(ch); if (fn) fn(msg); });
    this.r.on('error', (e) => console.error('[redis]', e.message));
    this.sub.on('error', (e) => console.error('[redis sub]', e.message));
  }
  async get(k) { return this.r.get(k); }
  async set(k, v, ttlSec) { if (ttlSec) await this.r.set(k, v, 'EX', ttlSec); else await this.r.set(k, v); }
  async del(k) { await this.r.del(k); }
  async lock(k, tok, ms) { return (await this.r.set(k, tok, 'PX', ms, 'NX')) === 'OK'; }
  async unlock(k, tok) { if ((await this.r.get(k)) === tok) await this.r.del(k); }
  async zadd(k, score, member) { await this.r.zadd(k, score, member); }
  async ztop(k, n) { const raw = await this.r.zrevrange(k, 0, n - 1, 'WITHSCORES'); const out = []; for (let i = 0; i < raw.length; i += 2) out.push([raw[i], Number(raw[i + 1])]); return out; }
  async zrank(k, member) { const r = await this.r.zrevrank(k, member); return r == null ? null : Number(r); }
  async hset(k, f, v) { await this.r.hset(k, f, v); }
  async hmget(k, fields) { return fields.length ? this.r.hmget(k, ...fields) : []; }
  async hkeys(k) { return this.r.hkeys(k); }
  async hdel(k, f) { await this.r.hdel(k, f); }
  async publish(ch, msg) { await this.r.publish(ch, msg); }
  async subscribe(ch, fn) { this.handlers.set(ch, fn); await this.sub.subscribe(ch); }
  async unsubscribe(ch) { this.handlers.delete(ch); await this.sub.unsubscribe(ch); }
}

export async function makeStore() {
  let url = process.env.REDIS_URL || process.env.KV_URL || '';
  // Upstash (offre gratuite du Marketplace Vercel) ne fournit parfois que ses variables REST :
  // on en deduit l'adresse Redis classique, le jeton REST servant de mot de passe.
  if (!url) {
    const rest = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
    if (rest && token) { try { url = 'rediss://default:' + encodeURIComponent(token) + '@' + new URL(rest).host + ':6379'; } catch (_) {} }
  }
  if (!url) { console.warn('[grande-descente] REDIS_URL absent : etat en memoire (une seule instance).'); return new MemoryStore(); }
  const { default: Redis } = await import('ioredis');
  return new RedisStore(new Redis(url, { maxRetriesPerRequest: 3, enableReadyCheck: false }));
}
