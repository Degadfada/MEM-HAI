// Learning from outcomes. Two learners over the same evidence:
//  1) a Thompson-sampling bandit per (task type, prompt technique), which works from the first outcome;
//  2) a tiny neural net (1 hidden layer) that generalises across task types once there is enough data.
// All state is REPLAYED from `learn.outcome` events in the ledger. Nothing is stored separately, so it can be audited and rebuilt.
import type { Ledger } from "./ledger.ts";
import { pathInScope, liveContracts } from "./scope.ts";
import { prng } from "./sketch.ts";

export const TASK_TYPES = ["bugfix", "feature", "refactor", "test", "docs", "review", "other"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const ARMS = ["goal-first", "constraints-sandwich", "minimal-diff", "test-first", "plan-then-act", "precedents"] as const;
export type Arm = (typeof ARMS)[number];

export function classifyTask(text: string): TaskType {
  const t = text.toLowerCase();
  const rules: Array<[TaskType, RegExp]> = [
    ["bugfix", /\b(bug|fix|broken|crash|error|fails?|failing|regression|exception|doesn'?t work)\b/],
    ["test", /\b(tests?|coverage|spec|unit test|e2e)\b/],
    ["refactor", /\b(refactor|clean ?up|rename|restructure|simplify|extract|deduplicate)\b/],
    ["docs", /\b(docs?|readme|document|comment|changelog)\b/],
    ["review", /\b(review|audit|check|inspect|assess)\b/],
    ["feature", /\b(add|implement|build|create|support|new|introduce|feature)\b/],
  ];
  for (const [k, re] of rules) if (re.test(t)) return k;
  return "other";
}

export interface Outcome { dispatch: string; taskType: TaskType; arm: Arm; reward: number; promptTokens: number; hardRules: number; hasContract: boolean }

/** Reward in [0,1] = mean of the signals that apply. Reads the raw ledger window after the dispatch. */
export function computeReward(l: Ledger, dispatchId: string): { reward: number; signals: Record<string, number> } {
  const d = l.get(dispatchId);
  if (!d || d.action !== "dispatch") throw new Error(`not a dispatch: ${dispatchId}`);
  const contractId = (d.payload as { contract?: string } | undefined)?.contract;
  const endEv = l.all().find((e) => e.action === "dispatch.done" && e.target === dispatchId);
  const win = l.all().filter((e) => e.seq > d.seq && (!endEv || e.seq < endEv.seq));
  const signals: Record<string, number> = {};
  signals.noBlocked = win.some((e) => e.action === "guardrail.blocked") ? 0 : 1;
  const aiIds = new Set(win.filter((e) => e.actor.kind === "ai" && e.delta === 1).map((e) => e.id));
  signals.noReversals = win.some((e) => e.reverses && aiIds.has(e.reverses)) ? 0 : 1;
  if (contractId) {
    const live = liveContracts(l).find((c) => c.id === contractId);
    const c = live ?? (() => { const o = l.all().find((e) => e.action === "contract.open" && e.target === contractId); if (!o) return undefined; const p = (o.payload ?? {}) as any; return { inScope: p.inScope ?? [], outOfScope: p.outOfScope ?? [], acceptance: p.acceptance ?? [] }; })();
    if (c) {
      signals.inScope = win.some((e) => e.actor.kind === "ai" && e.delta === 1 && !l.isReversed(e.id) && e.action.startsWith("file.") && e.target && !pathInScope(c, e.target).ok) ? 0 : 1;
      if (c.acceptance.length) {
        const done = new Set(win.filter((e) => e.action === "contract.accept" && e.target === contractId && e.delta === 1 && !l.isReversed(e.id)).map((e) => (e.payload as { item: number }).item));
        signals.accepted = done.size / c.acceptance.length;
      }
    }
  }
  const v = Object.values(signals);
  return { reward: v.reduce((a, b) => a + b, 0) / v.length, signals };
}

/** Record the outcome once the human says the dispatch is finished. */
export function finishDispatch(l: Ledger, by: { kind: "human"; name: string }, dispatchId: string) {
  const d = l.get(dispatchId);
  if (!d || d.action !== "dispatch") throw new Error(`not a dispatch: ${dispatchId}`);
  if (l.all().some((e) => e.action === "dispatch.done" && e.target === dispatchId)) throw new Error("dispatch already finished");
  l.append({ actor: by, action: "dispatch.done", target: dispatchId, summary: "task finished", source: "manual" });
  const { reward, signals } = computeReward(l, dispatchId);
  const p = d.payload as { taskType: TaskType; arm: Arm; promptTokens?: number; hardRules?: number; contract?: string };
  l.append({ actor: { kind: "system", name: "learner" }, action: "learn.outcome", target: dispatchId, summary: `reward ${reward.toFixed(2)}`, payload: { taskType: p.taskType, arm: p.arm, reward, signals, promptTokens: p.promptTokens ?? 0, hardRules: p.hardRules ?? 0, hasContract: !!p.contract }, source: "learner" });
  return { reward, signals };
}

export function loadOutcomes(l: Ledger): Outcome[] {
  const out: Outcome[] = [];
  for (const e of l.all()) {
    if (e.action !== "learn.outcome" || e.delta !== 1 || l.isReversed(e.id)) continue; // reversing an outcome un-learns it
    const p = e.payload as any;
    if (!TASK_TYPES.includes(p?.taskType) || !ARMS.includes(p?.arm) || typeof p?.reward !== "number") continue;
    out.push({ dispatch: e.target ?? "", taskType: p.taskType, arm: p.arm, reward: Math.min(1, Math.max(0, p.reward)), promptTokens: p.promptTokens ?? 0, hardRules: p.hardRules ?? 0, hasContract: !!p.hasContract });
  }
  return out;
}

// ---------- sampling helpers ----------
function normal(rng: () => number) { return Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng()); }
function gamma(a: number, rng: () => number): number {
  if (a < 1) return gamma(a + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / a);
  const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export const betaSample = (a: number, b: number, rng: () => number) => { const x = gamma(a, rng), y = gamma(b, rng); return x / (x + y); };

// ---------- tiny neural network ----------
const featureLen = TASK_TYPES.length + ARMS.length + 3;
export function features(o: { taskType: TaskType; arm: Arm; promptTokens: number; hardRules: number; hasContract: boolean }): number[] {
  const f = new Array(featureLen).fill(0);
  f[TASK_TYPES.indexOf(o.taskType)] = 1;
  f[TASK_TYPES.length + ARMS.indexOf(o.arm)] = 1;
  f[featureLen - 3] = Math.min(1, o.promptTokens / 2000);
  f[featureLen - 2] = Math.min(1, o.hardRules / 10);
  f[featureLen - 1] = o.hasContract ? 1 : 0;
  return f;
}

export class MLP {
  readonly H: number;
  w1: number[][]; b1: number[]; w2: number[]; b2 = 0;
  constructor(inputs = featureLen, hidden = 12, seed = 42) {
    this.H = hidden;
    const r = prng(seed);
    const init = () => (r() - 0.5) * 2; // +-1: a smaller start sits on the symmetric saddle and never learns interactions
    this.w1 = Array.from({ length: hidden }, () => Array.from({ length: inputs }, init));
    this.b1 = new Array(hidden).fill(0);
    this.w2 = Array.from({ length: hidden }, init);
  }
  private forward(x: number[]) {
    const h = this.w1.map((row, j) => Math.tanh(row.reduce((s, w, i) => s + w * x[i]!, this.b1[j]!)));
    const z = h.reduce((s, v, j) => s + v * this.w2[j]!, this.b2);
    return { h, y: 1 / (1 + Math.exp(-z)) };
  }
  predict(x: number[]) { return this.forward(x).y; }
  /** One SGD step on log-loss with a soft target in [0,1]. */
  step(x: number[], target: number, lr: number) {
    const { h, y } = this.forward(x);
    const dz = y - target; // d(logloss)/dz for a sigmoid output
    for (let j = 0; j < this.H; j++) {
      const dh = dz * this.w2[j]! * (1 - h[j]! * h[j]!);
      this.w2[j] = this.w2[j]! - lr * dz * h[j]!;
      for (let i = 0; i < x.length; i++) this.w1[j]![i] = this.w1[j]![i]! - lr * dh * x[i]!;
      this.b1[j] = this.b1[j]! - lr * dh;
    }
    this.b2 -= lr * dz;
  }
  train(data: Array<{ x: number[]; y: number }>, epochs = 300, lr = 0.15, seed = 7) {
    const r = prng(seed);
    for (let e = 0; e < epochs; e++) {
      const order = data.map((_, i) => i).sort(() => r() - 0.5);
      for (const i of order) this.step(data[i]!.x, data[i]!.y, lr);
    }
  }
}

export interface Choice { arm: Arm; via: "bandit" | "bandit+network" | "explore"; scores: Record<string, number> }
export const NETWORK_MIN_OUTCOMES = 20;

export class Learner {
  readonly outcomes: Outcome[];
  readonly net: MLP | null;
  constructor(outcomes: Outcome[], seed = 1) {
    this.outcomes = outcomes;
    if (outcomes.length >= NETWORK_MIN_OUTCOMES) {
      this.net = new MLP(featureLen, 12, seed);
      this.net.train(outcomes.map((o) => ({ x: features(o), y: o.reward })));
    } else this.net = null;
  }
  stats(taskType: TaskType, arm: Arm) {
    const own = this.outcomes.filter((o) => o.taskType === taskType && o.arm === arm);
    const all = this.outcomes.filter((o) => o.arm === arm && o.taskType !== taskType);
    const s = own.reduce((n, o) => n + o.reward, 0), f = own.length - s;
    const sa = all.reduce((n, o) => n + o.reward, 0), fa = all.length - sa;
    // other task types lend a quarter of their evidence as a prior
    return { n: own.length, alpha: 1 + s + 0.25 * sa, beta: 1 + f + 0.25 * fa, mean: (1 + s + 0.25 * sa) / (2 + own.length + 0.25 * all.length) };
  }
  choose(taskType: TaskType, ctx: { promptTokens?: number; hardRules?: number; hasContract?: boolean } = {}, rng: () => number = Math.random): Choice {
    const scores: Record<string, number> = {};
    let best: Arm = ARMS[0]!, bestV = -1;
    for (const arm of ARMS) {
      const st = this.stats(taskType, arm);
      let v = betaSample(st.alpha, st.beta, rng);
      if (this.net) v = 0.5 * v + 0.5 * this.net.predict(features({ taskType, arm, promptTokens: ctx.promptTokens ?? 800, hardRules: ctx.hardRules ?? 0, hasContract: !!ctx.hasContract }));
      scores[arm] = v;
      if (v > bestV) (bestV = v), (best = arm);
    }
    const unexplored = ARMS.every((a) => this.stats(taskType, a).n === 0);
    return { arm: best, via: unexplored ? "explore" : this.net ? "bandit+network" : "bandit", scores };
  }
}
