import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBrief } from "../src/handoff.ts";
import { verifyBrief, buildVerifiedBrief } from "../src/verify.ts";
import { Ledger } from "../src/ledger.ts";
import { sampleLedger, tmpPath, human } from "./helpers.ts";

test("a normal brief passes verification", async () => {
  const l = sampleLedger();
  const r = await verifyBrief(l, makeBrief(l, "copilot", "claude-md"));
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.equal(r.hardChecked, 3);
});

test("dropping a hard rule is caught (exhaustive check)", async () => {
  const l = sampleLedger();
  const b = makeBrief(l, "copilot", "claude-md");
  b.text = b.text.split("\n").filter((x) => !/pnpm/.test(x)).join("\n");
  const r = await verifyBrief(l, b);
  assert.equal(r.pass, false);
  assert.equal(r.hardMissing.length, 1);
});

test("a reversed decision leaking into the brief is caught as a zombie", async () => {
  const l = sampleLedger();
  const b = makeBrief(l, "copilot", "claude-md");
  b.text += "\n- Switch to Tailwind\n";
  const r = await verifyBrief(l, b);
  assert.equal(r.pass, false);
  assert.deepEqual(r.zombies, ["Switch to Tailwind"]);
});

test("sampling: h = ceil(ln(1/delta)/eps) = 60 at 5%/5% and catches a heavily lossy brief", async () => {
  const l = new Ledger(tmpPath());
  for (let i = 0; i < 300; i++) l.append({ actor: human, action: "decision", target: `topic${i}`, summary: `decide thing number ${i} using approach ${i * 7}` });
  const tiny = makeBrief(l, "x", "claude-md", 250);
  const r = await verifyBrief(l, tiny);
  assert.equal(r.probes, 60);
  assert.equal(r.sampledExhaustively, false);
  assert.equal(r.pass, false);
  assert.ok(r.sampledMisses.length > 10);
});

test("verification loop grows the budget until the brief passes", async () => {
  const l = new Ledger(tmpPath());
  l.append({ actor: human, action: "constraint", summary: "Never push to main" });
  for (let i = 0; i < 40; i++) l.append({ actor: human, action: "decision", target: `topic${i}`, summary: `decide thing number ${i} using approach ${i * 7}` });
  const t = await buildVerifiedBrief(l, "x", "claude-md", { startBudget: 300, cap: 6000 });
  assert.equal(t.report.pass, true);
  assert.ok(t.rounds > 1 && t.budget > 300);
});

test("probe draws are reproducible for a fixed seed", async () => {
  const l = new Ledger(tmpPath());
  for (let i = 0; i < 200; i++) l.append({ actor: human, action: "decision", target: `t${i}`, summary: `choice ${i} approach ${i * 3}` });
  const b = makeBrief(l, "x", "claude-md", 300);
  const a1 = await verifyBrief(l, b, { seed: 5 }), a2 = await verifyBrief(l, b, { seed: 5 });
  assert.deepEqual(a1.sampledMisses, a2.sampledMisses);
});
