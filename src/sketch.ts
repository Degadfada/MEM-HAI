// Seeded, mergeable sketches. Seeds come from the ledger header so sketches built at
// different times (or on different machines) can be merged and reproduced.

/** 32-bit seeded string hash (FNV-1a core with a murmur-style finalizer). */
export function hash32(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

/** Count-Min sketch. Never underestimates; overestimates by <= eps*N with prob >= 1-delta.
 *  Supports negative updates (strict turnstile) so reversals can subtract. */
export class CountMin {
  readonly width: number;
  readonly depth: number;
  readonly seeds: number[];
  readonly table: Int32Array;
  total = 0;

  constructor(seeds: number[], eps = 0.01, delta = 0.05) {
    this.width = nextPow2(2 / eps);
    this.depth = Math.min(seeds.length, Math.max(1, Math.ceil(Math.log2(1 / delta))));
    this.seeds = seeds.slice(0, this.depth);
    this.table = new Int32Array(this.width * this.depth);
  }

  private idx(row: number, key: string) {
    return row * this.width + (hash32(key, this.seeds[row]!) & (this.width - 1));
  }

  add(key: string, delta = 1) {
    for (let r = 0; r < this.depth; r++) this.table[this.idx(r, key)]! += delta;
    this.total += delta;
  }

  estimate(key: string): number {
    let m = Infinity;
    for (let r = 0; r < this.depth; r++) m = Math.min(m, this.table[this.idx(r, key)]!);
    return Math.max(0, m);
  }

  merge(o: CountMin) {
    if (o.width !== this.width || o.depth !== this.depth || o.seeds.some((s, i) => s !== this.seeds[i]))
      throw new Error("cannot merge sketches with different shape or seeds");
    for (let i = 0; i < this.table.length; i++) this.table[i]! += o.table[i]!;
    this.total += o.total;
  }
}

/** Misra-Gries heavy hitters with k counters: any item with frequency > N/(k+1) is retained. */
export class MisraGries {
  readonly k: number;
  counters = new Map<string, number>();
  constructor(k = 16) {
    this.k = k;
  }
  add(key: string) {
    const c = this.counters;
    if (c.has(key)) c.set(key, c.get(key)! + 1);
    else if (c.size < this.k) c.set(key, 1);
    else {
      for (const [x, n] of c) n <= 1 ? c.delete(x) : c.set(x, n - 1);
    }
  }
  top(): Array<[string, number]> {
    return [...this.counters].sort((a, b) => b[1] - a[1]);
  }
}

/** MinHash signature over a set of shingles; estimates Jaccard similarity. */
export function shingles(text: string, n = 3): Set<string> {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  if (t.length <= n) {
    out.add(t);
    return out;
  }
  for (let i = 0; i <= t.length - n; i++) out.add(t.slice(i, i + n));
  return out;
}

export function minhash(set: Set<string>, seeds: number[]): number[] {
  return seeds.map((seed) => {
    let m = 0xffffffff;
    for (const s of set) m = Math.min(m, hash32(s, seed));
    return m;
  });
}

export function jaccardEstimate(a: number[], b: number[]): number {
  let eq = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
  return eq / a.length;
}

/** LSH banding (OR over bands, AND within a band). Returns bucket keys for a signature. */
export function lshBuckets(sig: number[], rows: number): string[] {
  const out: string[] = [];
  for (let b = 0; b * rows < sig.length; b++) out.push(b + ":" + sig.slice(b * rows, (b + 1) * rows).join("."));
  return out;
}

/** Reservoir sampling (Algorithm R) with an injectable RNG for tests. */
export function reservoir<T>(items: Iterable<T>, k: number, rng: () => number = Math.random): T[] {
  const res: T[] = [];
  let i = 0;
  for (const it of items) {
    if (i < k) res.push(it);
    else {
      const j = Math.floor(rng() * (i + 1));
      if (j < k) res[j] = it;
    }
    i++;
  }
  return res;
}

/** Seeded PRNG (mulberry32) so verification probe draws are reproducible. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
