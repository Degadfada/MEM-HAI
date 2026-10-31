// Password login for remote access (through a tunnel you control). scrypt hashes, random sessions, throttled logins.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const MIN_LEN = 12;
const file = (home: string) => join(home, "auth.json");

export function setPassword(home: string, password: string) {
  if (typeof password !== "string" || password.length < MIN_LEN) throw new Error(`password must be at least ${MIN_LEN} characters`);
  mkdirSync(home, { recursive: true });
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  writeFileSync(file(home), JSON.stringify({ v: 1, salt: salt.toString("hex"), hash: hash.toString("hex") }), { mode: 0o600 });
  try { chmodSync(file(home), 0o600); } catch {}
}
export const hasPassword = (home: string) => existsSync(file(home));
export function checkPassword(home: string, password: string): boolean {
  try {
    const j = JSON.parse(readFileSync(file(home), "utf8"));
    const want = Buffer.from(j.hash, "hex");
    const got = scryptSync(String(password), Buffer.from(j.salt, "hex"), want.length, { N: 16384, r: 8, p: 1 });
    return timingSafeEqual(got, want);
  } catch { return false; }
}

export interface Throttle { check(ip: string): { ok: true } | { ok: false; retryAfterSec: number }; fail(ip: string): void; clear(ip: string): void }
/** 5 failures per IP and 30 failures overall inside the window lock logins. The global cap stops distributed guessing. */
export function makeThrottle(now: () => number = Date.now, windowMs = 10 * 60_000, perIp = 5, global = 30): Throttle {
  const byIp = new Map<string, number[]>();
  let all: number[] = [];
  const prune = (a: number[]) => a.filter((t) => now() - t < windowMs);
  return {
    check(ip) {
      all = prune(all);
      const mine = prune(byIp.get(ip) ?? []);
      byIp.set(ip, mine);
      const lock = mine.length >= perIp ? mine[0]! : all.length >= global ? all[0]! : null;
      return lock === null ? { ok: true } : { ok: false, retryAfterSec: Math.max(1, Math.ceil((lock + windowMs - now()) / 1000)) };
    },
    fail(ip) { const t = now(); all.push(t); byIp.set(ip, [...prune(byIp.get(ip) ?? []), t]); },
    clear(ip) { byIp.delete(ip); },
  };
}

export class Sessions {
  private m = new Map<string, number>();
  private now: () => number;
  private ttlMs: number;
  private max: number;
  constructor(now: () => number = Date.now, ttlMs = 8 * 3600_000, max = 20) { this.now = now; this.ttlMs = ttlMs; this.max = max; }
  create(): string {
    for (const [k, exp] of this.m) if (exp < this.now()) this.m.delete(k);
    while (this.m.size >= this.max) this.m.delete(this.m.keys().next().value!);
    const t = randomBytes(32).toString("hex");
    this.m.set(t, this.now() + this.ttlMs);
    return t;
  }
  valid(t: string | undefined): boolean {
    if (!t) return false;
    const exp = this.m.get(t);
    if (!exp) return false;
    if (exp < this.now()) { this.m.delete(t); return false; }
    return true;
  }
  destroy(t: string | undefined) { if (t) this.m.delete(t); }
  get ttlSeconds() { return Math.floor(this.ttlMs / 1000); }
}

export const cookieOf = (header: string | undefined, name: string): string | undefined => {
  for (const part of (header ?? "").split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return v.join("="); }
  return undefined;
};
