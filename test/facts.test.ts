import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFacts } from "../src/facts.ts";
import { buildModel, scoreFacts, surprisal } from "../src/score.ts";
import { CountMin, MisraGries, minhash, shingles, jaccardEstimate, reservoir, prng } from "../src/sketch.ts";
import { sampleLedger } from "./helpers.ts";

test("facts: constraints are hard, reversed decisions vanish, done tasks vanish", () => {
  const facts = extractFacts(sampleLedger().all());
  const hard = facts.filter((f) => f.hard).map((f) => f.kind).sort();
  assert.deepEqual(hard, ["constraint", "constraint", "denial"]);
  assert.ok(!facts.some((f) => /Tailwind/.test(f.text)), "reversed decision must be gone");
  assert.ok(!facts.some((f) => f.key === "fix-footer"));
  assert.ok(facts.some((f) => f.key === "rate-limit-login"));
});

test("facts: every fact cites real source events", () => {
  const l = sampleLedger();
  const ids = new Set(l.all().map((e) => e.id));
  for (const f of extractFacts(l.all())) {
    assert.ok(f.sources.length > 0);
    for (const s of f.sources) assert.ok(ids.has(s));
  }
});

test("facts: 30 edits over 6 files collapse to 6 file facts; approval pattern appears", () => {
  const facts = extractFacts(sampleLedger().all());
  assert.equal(facts.filter((f) => f.kind === "file" && f.key.startsWith("src/ui/")).length, 6);
  assert.ok(facts.some((f) => f.kind === "approval_pattern" && /file\.edit/.test(f.text)));
});

test("score: rare actions carry more surprisal than frequent ones; hard facts outrank all", () => {
  const l = sampleLedger();
  const m = buildModel(l.all(), l.header.seeds.countMin);
  assert.ok(surprisal(m, "a:decision") > surprisal(m, "a:file.edit"));
  const scored = scoreFacts(extractFacts(l.all()), l.all(), m);
  const maxSoft = Math.max(...scored.filter((f) => !f.hard).map((f) => f.utility));
  assert.ok(scored.filter((f) => f.hard).every((f) => f.utility > maxSoft));
});

test("model: reversal subtracts from counts", () => {
  const l = sampleLedger();
  const m = buildModel(l.all(), l.header.seeds.countMin);
  assert.equal(m.cm.estimate("a:decision"), 1); // Tailwind decision was reversed; only auth survives
});

test("CountMin never underestimates and merges", () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = new CountMin(seeds, 0.05, 0.05), b = new CountMin(seeds, 0.05, 0.05);
  const truth = new Map<string, number>();
  const rng = prng(7);
  for (let i = 0; i < 5000; i++) {
    const k = "k" + Math.floor(rng() * rng() * 300);
    (i % 2 ? a : b).add(k);
    truth.set(k, (truth.get(k) ?? 0) + 1);
  }
  a.merge(b);
  let over = 0;
  for (const [k, c] of truth) {
    const est = a.estimate(k);
    assert.ok(est >= c, "underestimate!");
    if (est - c > 0.05 * 5000) over++;
  }
  assert.ok(over / truth.size <= 0.05 + 0.02);
  assert.throws(() => a.merge(new CountMin([9, 9, 9, 9, 9, 9, 9, 9], 0.05, 0.05)), /different/);
});

test("Misra-Gries keeps any item above N/(k+1)", () => {
  const mg = new MisraGries(4);
  const stream = [...Array(60).fill("hot"), ...Array.from({ length: 40 }, (_, i) => "x" + i)];
  prng(3); stream.sort((a, b) => (a < b ? 1 : -1)).forEach((s) => mg.add(s));
  assert.ok(mg.counters.has("hot"));
});

test("MinHash estimates Jaccard", () => {
  const seeds = Array.from({ length: 128 }, (_, i) => i * 7919 + 13);
  const a = minhash(shingles("use session cookies not jwt for the web app"), seeds);
  const b = minhash(shingles("use session cookies not jwt for the website"), seeds);
  const c = minhash(shingles("completely different sentence about databases"), seeds);
  assert.ok(jaccardEstimate(a, b) > 0.5);
  assert.ok(jaccardEstimate(a, c) < 0.2);
});

test("reservoir returns k items, uniform-ish", () => {
  const r = reservoir(Array.from({ length: 1000 }, (_, i) => i), 10, prng(1));
  assert.equal(r.length, 10);
});
