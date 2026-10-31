import type { Scored } from "./score.ts";
import { jaccardEstimate, lshBuckets, minhash, shingles } from "./sketch.ts";

export interface DistillResult {
  kept: Scored[];
  dropped: Scored[];
  usedTokens: number;
  budget: number;
  overBudgetByHard: boolean; // hard constraints alone exceeded the budget
}

const nums = (t: string) => (t.match(/\d+/g) ?? []).join(",");

/** Merge near-duplicate facts (MinHash + LSH). Keeps the higher-utility text, unions sources. */
export function dedupe(facts: Scored[], seeds: number[], threshold = 0.8): Scored[] {
  const rows = 2;
  const sigs = facts.map((f) => minhash(shingles(f.text), seeds));
  const buckets = new Map<string, number[]>();
  facts.forEach((_, i) => {
    for (const b of lshBuckets(sigs[i]!, rows)) (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(i);
  });
  const parent = facts.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (const idxs of buckets.values())
    for (let a = 0; a < idxs.length; a++)
      for (let b = a + 1; b < idxs.length; b++) {
        const i = idxs[a]!, j = idxs[b]!;
        // only merge facts of the same kind: two different files must never collapse
        if (facts[i]!.kind !== facts[j]!.kind) continue;
        // facts that differ in any number (ids, versions, counts) are different facts
        if (nums(facts[i]!.text) !== nums(facts[j]!.text)) continue;
        if (jaccardEstimate(sigs[i]!, sigs[j]!) >= threshold) parent[find(i)] = find(j);
      }
  const groups = new Map<number, Scored[]>();
  facts.forEach((f, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(f));
  return [...groups.values()].map((g) => {
    g.sort((a, b) => b.utility - a.utility);
    const best = { ...g[0]! };
    if (g.length > 1) {
      best.sources = [...new Set(g.flatMap((x) => x.sources))];
      best.hard = g.some((x) => x.hard);
    }
    return best;
  });
}

/**
 * Budgeted selection. Objective F(S) = sum over aspects a of sqrt(sum of utility of facts in S covering a).
 * Concave-of-modular, so F is monotone submodular: repeated coverage of one aspect (30 edits to one
 * folder) has diminishing value. Hard facts are taken first, unconditionally.
 * Cost-benefit greedy, compared against the best single feasible fact, gives a constant-factor
 * approximation for knapsack-constrained submodular maximisation (>= (1 - 1/sqrt(e)) ~ 0.39 of optimum).
 */
export function distill(facts: Scored[], budgetTokens: number): DistillResult {
  const hard = facts.filter((f) => f.hard);
  const soft = facts.filter((f) => !f.hard);
  const kept: Scored[] = [...hard];
  let used = hard.reduce((n, f) => n + f.tokens, 0);
  const overBudgetByHard = used > budgetTokens;

  const mass = new Map<string, number>(); // aspect -> utility mass already selected
  const gain = (f: Scored) => {
    let g = 0;
    for (const a of f.aspects) {
      const m = mass.get(a) ?? 0;
      g += Math.sqrt(m + f.utility) - Math.sqrt(m);
    }
    return g;
  };
  const take = (f: Scored) => {
    kept.push(f);
    used += f.tokens;
    for (const a of f.aspects) mass.set(a, (mass.get(a) ?? 0) + f.utility);
  };

  const remaining = new Set(soft);
  const greedy: Scored[] = [];
  let greedyUsed = used;
  const savedMass = new Map(mass);
  while (remaining.size) {
    let best: Scored | undefined, bestRatio = 0;
    for (const f of remaining) {
      if (greedyUsed + f.tokens > budgetTokens) continue;
      const r = gain(f) / f.tokens;
      if (r > bestRatio) (bestRatio = r), (best = f);
    }
    if (!best) break;
    remaining.delete(best);
    greedy.push(best);
    greedyUsed += best.tokens;
    for (const a of best.aspects) mass.set(a, (mass.get(a) ?? 0) + best.utility);
  }
  // Best single fact alone (guards against many cheap items beating one valuable expensive one).
  mass.clear();
  for (const [k, v] of savedMass) mass.set(k, v);
  const value = (set: Scored[]) => {
    const m = new Map(savedMass);
    for (const f of set) for (const a of f.aspects) m.set(a, (m.get(a) ?? 0) + f.utility);
    let v = 0;
    for (const x of m.values()) v += Math.sqrt(x);
    return v;
  };
  const singles = soft.filter((f) => used + f.tokens <= budgetTokens).sort((a, b) => value([b]) - value([a]));
  const chosen = singles.length && value([singles[0]!]) > value(greedy) ? [singles[0]!] : greedy;
  mass.clear();
  for (const [k, v] of savedMass) mass.set(k, v);
  for (const f of chosen) take(f);

  const keptIds = new Set(kept.map((f) => f.id));
  return { kept, dropped: facts.filter((f) => !keptIds.has(f.id)), usedTokens: used, budget: budgetTokens, overBudgetByHard };
}
