import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.ts";
import { classifyTask, computeReward, finishDispatch, loadOutcomes, Learner, MLP, features, betaSample, ARMS, type Outcome, type Arm, type TaskType } from "../src/learn.ts";
import { openContract, acceptItem } from "../src/scope.ts";
import { prng } from "../src/sketch.ts";
import { tmpPath, claude } from "./helpers.ts";

const me = { kind: "human" as const, name: "me" };

test("task classifier", () => {
  assert.equal(classifyTask("Fix the crash when login fails"), "bugfix");
  assert.equal(classifyTask("add unit tests for the parser"), "test");
  assert.equal(classifyTask("refactor the billing module"), "refactor");
  assert.equal(classifyTask("update the README"), "docs");
  assert.equal(classifyTask("implement CSV export"), "feature");
  assert.equal(classifyTask("hmm"), "other");
});

test("beta sampler has the right mean", () => {
  const r = prng(3);
  const m = Array.from({ length: 4000 }, () => betaSample(8, 2, r)).reduce((a, b) => a + b, 0) / 4000;
  assert.ok(Math.abs(m - 0.8) < 0.02, String(m));
});

test("reward from the ledger: clean run scores 1; blocked, reverted and out-of-scope work scores lower", () => {
  const l = new Ledger(tmpPath());
  openContract(l, me, { id: "c1", goal: "g", acceptance: ["a", "b"], inScope: ["src/**"] });
  const mkDispatch = () => l.append({ actor: { kind: "system", name: "steward" }, action: "dispatch", summary: "task", payload: { taskType: "bugfix", arm: "test-first", contract: "c1", promptTokens: 500, hardRules: 2 } });

  const d1 = mkDispatch();
  l.append({ actor: claude, action: "file.edit", target: "src/a.ts" });
  acceptItem(l, claude, "c1", 0); acceptItem(l, me, "c1", 1);
  const r1 = finishDispatch(l, me, d1.id);
  assert.equal(r1.reward, 1);
  assert.throws(() => finishDispatch(l, me, d1.id), /already finished/);

  const d2 = mkDispatch();
  l.append({ actor: claude, action: "guardrail.blocked", target: "rm -rf /" });
  const stray = l.append({ actor: claude, action: "file.edit", target: "docs/x.md" });
  l.reverse(stray.id, me);
  const r2 = finishDispatch(l, me, d2.id);
  assert.equal(r2.signals.noBlocked, 0);
  assert.equal(r2.signals.noReversals, 0);
  assert.equal(r2.signals.inScope, 1, "the stray edit was reverted, so it no longer counts as out of scope");
  assert.ok(r2.reward < 0.6);

  const outcomes = loadOutcomes(l);
  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes.map((o) => o.arm), ["test-first", "test-first"]);
  // reversing an outcome event un-learns it
  l.reverse(l.all().filter((e) => e.action === "learn.outcome")[1]!.id, me);
  assert.equal(loadOutcomes(l).length, 1);
  assert.throws(() => computeReward(l, "nope"), /not a dispatch/);
});

test("MLP learns XOR-like structure (the net can represent interactions, not just sums)", () => {
  const net = new MLP(2, 8, 5);
  const data = [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]].map(([a, b, y]) => ({ x: [a!, b!], y: y! }));
  net.train(data, 4000, 0.3);
  for (const d of data) assert.ok(Math.abs(net.predict(d.x) - d.y) < 0.15, JSON.stringify(d));
});

function synth(n: number, seed: number): Outcome[] {
  const r = prng(seed), out: Outcome[] = [];
  const good: Record<TaskType, Arm> = { bugfix: "test-first", feature: "plan-then-act", refactor: "minimal-diff", test: "test-first", docs: "goal-first", review: "constraints-sandwich", other: "goal-first" };
  const types = Object.keys(good) as TaskType[];
  for (let i = 0; i < n; i++) {
    const taskType = types[Math.floor(r() * types.length)]!, arm = ARMS[Math.floor(r() * ARMS.length)]!;
    const p = arm === good[taskType] ? 0.9 : 0.3;
    out.push({ dispatch: "d" + i, taskType, arm, reward: r() < p ? 1 : 0, promptTokens: 800, hardRules: 2, hasContract: true });
  }
  return out;
}

function pickRate(L: Learner, rngSeed: number) {
  const r = prng(rngSeed);
  let hits = 0, total = 0;
  for (const [type, want] of [["bugfix", "test-first"], ["feature", "plan-then-act"], ["refactor", "minimal-diff"], ["docs", "goal-first"]] as const)
    for (let i = 0; i < 40; i++) { total++; if (L.choose(type, { hardRules: 2, hasContract: true, promptTokens: 800 }, r).arm === want) hits++; }
  return hits / total;
}

test("learning is data-hungry and improves with evidence: chance ~17% at 100 outcomes, ~70% at 400, ~100% at 1500", () => {
  const small = pickRate(new Learner(synth(100, 11), 3), 99);
  const mid = pickRate(new Learner(synth(400, 11), 3), 99);
  const big = new Learner(synth(1500, 11), 3);
  const large = pickRate(big, 99);
  assert.ok(small > 0.35, `100 outcomes: ${small}`);          // already far above the 1/6 chance level
  assert.ok(mid > 0.6, `400 outcomes: ${mid}`);
  assert.ok(large > 0.95, `1500 outcomes: ${large}`);
  assert.ok(large > mid && mid > small - 0.05);
  // the network alone also ranks the right technique first once it has enough data
  const rank = (t: TaskType) => [...ARMS].sort((a, b) => big.net!.predict(features({ taskType: t, arm: b, promptTokens: 800, hardRules: 2, hasContract: true })) - big.net!.predict(features({ taskType: t, arm: a, promptTokens: 800, hardRules: 2, hasContract: true })))[0];
  assert.equal(rank("bugfix"), "test-first");
  assert.equal(rank("review"), "constraints-sandwich");
  assert.equal(rank("refactor"), "minimal-diff");
});

test("with no outcomes it explores; with few it uses the bandit only", () => {
  assert.equal(new Learner([]).choose("bugfix").via, "explore");
  const few = new Learner(synth(10, 2));
  assert.equal(few.net, null);
  assert.equal(few.choose("bugfix").via, "bandit");
});

test("learning is replayed: same ledger gives the same learner", () => {
  const a = new Learner(synth(60, 4), 9), b = new Learner(synth(60, 4), 9);
  assert.deepEqual(a.choose("bugfix", {}, prng(1)), b.choose("bugfix", {}, prng(1)));
});
