import type { LedgerEvent } from "./types.ts";
import type { Fact } from "./facts.ts";
import { CountMin, MisraGries } from "./sketch.ts";

export interface Scored extends Fact {
  surprisal: number; // bits
  utility: number;
  tokens: number;
}

const KIND_WEIGHT: Record<string, number> = {
  constraint: 10, denial: 6, decision: 4, task: 4, approval_pattern: 3, ai_switch: 2, file: 1.5, command: 0.8,
};

export const estimateTokens = (s: string): number => Math.max(1, Math.ceil(s.length / 4));

export interface Model {
  cm: CountMin;
  hot: MisraGries;
  n: number;
  maxSeq: number;
}

/** One pass over the raw events: Count-Min for surprisal, Misra-Gries for "hot" targets. */
export function buildModel(events: readonly LedgerEvent[], cmSeeds: number[]): Model {
  const cm = new CountMin(cmSeeds, 0.01, 0.05);
  const hot = new MisraGries(16);
  let n = 0;
  for (const e of events) {
    if (e.delta !== 1) {
      // reversal = negative update on what it undid
      continue;
    }
    cm.add("a:" + e.action);
    if (e.target) {
      cm.add("t:" + e.target);
      hot.add(e.target);
    }
    n++;
  }
  for (const e of events) if (e.delta === -1 && e.reverses) {
    const orig = events.find((x) => x.id === e.reverses);
    if (orig) {
      cm.add("a:" + orig.action, -1);
      if (orig.target) cm.add("t:" + orig.target, -1);
      n--;
    }
  }
  return { cm, hot, n: Math.max(1, n), maxSeq: events.length ? events[events.length - 1]!.seq : 0 };
}

/** Surprisal -log2 p. Count-Min only overestimates counts, so surprisal is never overstated. */
export function surprisal(m: Model, key: string): number {
  const c = m.cm.estimate(key);
  return -Math.log2((c + 1) / (m.n + 1));
}

export function scoreFacts(facts: Fact[], events: readonly LedgerEvent[], m: Model, halfLifeEvents = 200): Scored[] {
  const bySeq = new Map(events.map((e) => [e.id, e]));
  const hotSet = new Set(m.hot.top().slice(0, 5).map(([k]) => k));
  return facts.map((f) => {
    const src = bySeq.get(f.sources[f.sources.length - 1]!);
    const action = src?.action ?? f.kind;
    let bits = surprisal(m, "a:" + action);
    if (f.kind === "file") bits += 0.5 * surprisal(m, "t:" + f.key);
    const age = m.maxSeq - f.lastSeq;
    const recency = Math.pow(0.5, age / halfLifeEvents);
    const hotBoost = f.kind === "file" && hotSet.has(f.key) ? 1.5 : 1;
    const utility = f.hard ? 1000 : (KIND_WEIGHT[f.kind] ?? 1) * (1 + bits) * (0.4 + 0.6 * recency) * hotBoost;
    return { ...f, surprisal: bits, utility, tokens: estimateTokens(f.text) };
  });
}
