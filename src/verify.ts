import type { Ledger } from "./ledger.ts";
import { makeBrief, type Brief, type Target, TARGET_BUDGETS } from "./handoff.ts";
import { prng } from "./sketch.ts";
import { extractFacts, type Fact } from "./facts.ts";

/** Answers "does this brief convey that fact?". Default is lexical; plug an LLM-backed reader in for real use. */
export type Reader = (brief: string, fact: Fact) => boolean | Promise<boolean>;

const tokens = (s: string) => new Set(s.toLowerCase().replace(/\[[0-9a-f]{8}\]/g, "").split(/[^a-z0-9_./-]+/).filter((w) => w.length > 1));
const jac = (a: Set<string>, b: Set<string>) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};

export const lexicalReader: Reader = (brief, fact) => {
  const ft = tokens(fact.text);
  return brief.split("\n").some((line) => jac(tokens(line), ft) >= 0.7 || (ft.size > 0 && [...ft].every((w) => tokens(line).has(w))));
};

export interface VerifyOptions {
  epsilon?: number; // tolerated miss fraction among "must-recall" facts
  delta?: number; // failure probability of the tester
  seed?: number;
  reader?: Reader;
}

export interface VerifyReport {
  pass: boolean;
  epsilon: number;
  delta: number;
  probes: number; // h = ceil(ln(1/delta)/epsilon), capped at population size
  population: number;
  sampledExhaustively: boolean;
  hardChecked: number;
  hardMissing: string[];
  zombies: string[]; // reversed/finished things that wrongly appear in the brief
  sampledMisses: string[];
  statement: string; // what the result does and does not certify
}

const MUST_RECALL = new Set(["decision", "task", "denial", "approval_pattern"]);

/** facts that must NOT be present: reversed decisions, finished tasks. */
function zombieStrings(ledger: Ledger): string[] {
  const ev = ledger.all();
  const out: string[] = [];
  const done = new Set(ev.filter((e) => e.action === "task.done").map((e) => e.target));
  for (const e of ev) {
    if (e.delta === 1 && ledger.isReversed(e.id) && e.summary && e.summary.length > 4) out.push(e.summary);
    if (e.action === "task.open" && done.has(e.target) && e.summary) out.push(e.summary);
  }
  return out;
}

/**
 * Property tester. Hard facts and zombie (must-be-absent) facts are checked exhaustively: a single miss is a fail.
 * Must-recall soft facts are sampled: if the brief misses an eps-fraction or more of them, the chance all
 * h = ceil(ln(1/delta)/eps) uniform probes succeed is <= (1-eps)^h <= delta. One-sided: "pass" certifies the
 * brief is not eps-far; it does not certify perfection. Sampling cannot certify rare catastrophic items,
 * which is why hard rules are never sampled.
 */
export async function verifyBrief(ledger: Ledger, brief: Brief, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const epsilon = opts.epsilon ?? 0.05, delta = opts.delta ?? 0.05;
  const read = opts.reader ?? lexicalReader;
  const rng = prng(opts.seed ?? 1234567);

  // Ground truth comes from the RAW ledger, not from the brief's own (deduped) fact list, so dedupe losses are caught.
  const truth = extractFacts(ledger.all());
  const hard = truth.filter((f) => f.hard);
  const hardMissing: string[] = [];
  for (const f of hard) if (!(await read(brief.text, f))) hardMissing.push(f.text);

  const zombies = zombieStrings(ledger).filter((z) => brief.text.includes(z));

  const pop = truth.filter((f) => !f.hard && MUST_RECALL.has(f.kind));
  const h = Math.ceil(Math.log(1 / delta) / epsilon);
  const exhaustive = pop.length <= h;
  const sample = exhaustive ? pop : (() => {
    const idx = pop.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j]!, idx[i]!]; }
    return idx.slice(0, h).map((i) => pop[i]!);
  })();
  const sampledMisses: string[] = [];
  for (const f of sample) if (!(await read(brief.text, f))) sampledMisses.push(f.text);

  const pass = hardMissing.length === 0 && zombies.length === 0 && sampledMisses.length === 0;
  return {
    pass, epsilon, delta, probes: sample.length, population: pop.length, sampledExhaustively: exhaustive,
    hardChecked: hard.length, hardMissing, zombies, sampledMisses,
    statement: exhaustive
      ? `Checked all ${pop.length} must-recall facts, all ${hard.length} hard rules, and all reversed/finished items. Exact for this ledger.`
      : `Hard rules and reversed/finished items checked exhaustively. For the ${pop.length} must-recall facts, ${sample.length} random probes: ` +
        (sampledMisses.length ? `${sampledMisses.length} missed.` : `0 missed, so with probability >= ${(1 - delta) * 100}% the brief misses fewer than ${(epsilon * 100).toFixed(0)}% of them.`),
  };
}

export interface TuneResult { brief: Brief; report: VerifyReport; budget: number; rounds: number; reachedCap: boolean }

/** Verification loop: grow the token budget (25%/round) until the brief passes or the cap is hit. */
export async function buildVerifiedBrief(ledger: Ledger, to: string, target: Target, opts: VerifyOptions & { startBudget?: number; cap?: number } = {}): Promise<TuneResult> {
  let budget = opts.startBudget ?? TARGET_BUDGETS[target];
  const cap = opts.cap ?? budget * 4;
  for (let rounds = 1; ; rounds++) {
    const brief = makeBrief(ledger, to, target, budget);
    const report = await verifyBrief(ledger, brief, opts);
    if (report.pass || budget >= cap) return { brief, report, budget, rounds, reachedCap: !report.pass };
    budget = Math.min(cap, Math.ceil(budget * 1.25));
  }
}
