import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBrief } from "../src/handoff.ts";
import { distill } from "../src/distill.ts";
import { buildModel, scoreFacts } from "../src/score.ts";
import { extractFacts } from "../src/facts.ts";
import { sampleLedger } from "./helpers.ts";

test("brief keeps every hard rule at any budget that can hold them", () => {
  const l = sampleLedger();
  for (const budget of [300, 500, 1500]) {
    const b = makeBrief(l, "copilot", "claude-md", budget);
    assert.equal(b.metrics.hardKept, b.metrics.hardTotal, `budget ${budget}`);
    assert.match(b.text, /Never modify the production database/);
    assert.match(b.text, /Use pnpm/);
  }
});

test("brief respects budget and compresses the log", () => {
  const l = sampleLedger();
  const b = makeBrief(l, "copilot", "claude-md", 400);
  assert.ok(b.metrics.briefTokens <= 400 + 60, `got ${b.metrics.briefTokens}`);
  assert.ok(b.metrics.compressionRatio > 3);
});

test("brief omits reversed decisions and finished tasks, keeps open tasks and live decisions", () => {
  const b = makeBrief(sampleLedger(), "copilot", "agents-md");
  assert.ok(!/Tailwind/.test(b.text));
  assert.ok(!/footer/.test(b.text));
  assert.match(b.text, /rate-limit-login/);
  assert.match(b.text, /session cookies/);
  assert.match(b.text, /taking over an in-progress project from claude-code/);
});

test("bigger budget never keeps less utility (monotone)", () => {
  const l = sampleLedger();
  const u = [200, 400, 800, 1600].map((n) => makeBrief(l, "x", "claude-md", n).metrics.utilityKept);
  for (let i = 1; i < u.length; i++) assert.ok(u[i]! >= u[i - 1]! - 1e-9);
});

test("greedy distiller is within 0.5x of brute-force optimum on small instances", () => {
  const l = sampleLedger();
  const m = buildModel(l.all(), l.header.seeds.countMin);
  const soft = scoreFacts(extractFacts(l.all()), l.all(), m).filter((f) => !f.hard).slice(0, 14);
  const budget = 60;
  const F = (set: typeof soft) => {
    const mass = new Map<string, number>();
    for (const f of set) for (const a of f.aspects) mass.set(a, (mass.get(a) ?? 0) + f.utility);
    let v = 0;
    for (const x of mass.values()) v += Math.sqrt(x);
    return v;
  };
  let opt = 0;
  for (let mask = 0; mask < 1 << soft.length; mask++) {
    const set = soft.filter((_, i) => mask & (1 << i));
    if (set.reduce((n, f) => n + f.tokens, 0) <= budget) opt = Math.max(opt, F(set));
  }
  const got = F(distill(soft, budget).kept);
  assert.ok(got >= 0.5 * opt, `greedy ${got} vs opt ${opt}`);
});

test("all four targets render and mcp-json is valid JSON with sources", () => {
  const l = sampleLedger();
  for (const t of ["claude-md", "agents-md", "system-prompt", "mcp-json"] as const) {
    const b = makeBrief(l, "copilot", t);
    assert.ok(b.text.length > 100);
    if (t === "mcp-json") {
      const j = JSON.parse(b.text);
      assert.equal(j.rules.length, 3);
      assert.ok(j.rules.every((r: any) => r.sources.length));
    }
  }
});

test("hard rules over budget are flagged, not silently dropped", () => {
  const b = makeBrief(sampleLedger(), "x", "claude-md", 130);
  assert.equal(b.metrics.hardKept, b.metrics.hardTotal);
  assert.match(b.text, /WARNING/);
});

test("an undone AI switch no longer counts as the AI in use", async () => {
  const { aiTrail } = await import("../src/handoff.ts");
  const l = sampleLedger();
  const sw = l.all().filter((e) => e.action === "ai.switch").at(-1)!;
  l.reverse(sw.id, { kind: "human", name: "me" });
  assert.deepEqual(aiTrail(l.all()), ["claude-code"]);
});
