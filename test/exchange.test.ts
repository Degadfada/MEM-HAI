import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";
import { Registry, callProvider } from "../src/providers.ts";
import { exchangeDir, findExchange, statedReason } from "../src/exchange.ts";
import { fakeAi } from "./fakeai.ts";
import { tmpPath } from "./helpers.ts";

const home = () => mkdtempSync(join(tmpdir(), "handoff-home-"));

/**
 * The point of this tier: for an API AI we are the client, so "why" is primary evidence rather than
 * something scraped out of a vendor's log.
 */
test("an API call records both sides of the exchange and a recorded rationale", async () => {
  const ai = await fakeAi(() => "Adding the retry so the 429s stop. Then I will cover it with a test.");
  const h = home();
  const l = new Ledger(tmpPath());
  try {
    const r = new Registry({
      home: h,
      env: { K: "sk-test-key" },
      onEvent: (e) => l.append({ actor: { kind: "system", name: "registry" }, action: e.action, summary: e.summary, payload: e.payload, rationale: e.rationale, source: "registry" }),
    });
    r.add({ name: "gpt", kind: "openai-compatible", model: "some-model", keyEnv: "K", baseUrl: ai.url });
    r.wake("gpt", "editor");

    const out = await r.complete("gpt", { prompt: "make the uploader retry", ask: "fix the flaky upload", approvedBy: "idahosa", dispatchId: "d1" });
    assert.match(out.text, /Adding the retry/);
    assert.equal(out.inputTokens, 70);
    assert.equal(out.outputTokens, 35);
    assert.ok(typeof out.latencyMs === "number", "latency is measured");

    const ev = l.all().find((e) => e.action === "ai.usage")!;
    assert.ok(ev, "the call reached the ledger");
    assert.equal(ev.rationale?.provenance, "recorded");
    assert.equal(ev.rationale?.ask, "fix the flaky upload");
    assert.equal(ev.rationale?.reason, "Adding the retry so the 429s stop.", "the reason is the model's own opening statement");
    assert.equal(ev.rationale?.approvedBy, "idahosa");
    assert.equal(ev.rationale?.ref?.dispatchId, "d1");

    // the citation resolves to the untruncated exchange
    const hash = ev.rationale!.ref!.exchangeSha256!;
    const ex = findExchange(h, hash)!;
    assert.ok(ex, "the citation resolves");
    assert.equal(ex.prompt, "make the uploader retry");
    assert.match(ex.reply, /Adding the retry/);
    assert.equal(ex.dispatchId, "d1");
    assert.equal(ex.model, "some-model");
  } finally {
    await ai.close();
  }
});

test("a pasted secret never reaches the exchange store", async () => {
  const ai = await fakeAi(() => "Done. The key you gave me is sk-ant-api03-SHOULDNOTPERSIST.");
  const h = home();
  try {
    const r = new Registry({ home: h, env: { K: "sk-test-key" } });
    r.add({ name: "p", kind: "openai-compatible", model: "m", keyEnv: "K", baseUrl: ai.url });
    r.wake("p", "editor");
    await r.complete("p", { prompt: "here is my key sk-ant-api03-ALSOSHOULDNOTPERSIST, use it" });

    const dir = exchangeDir(h);
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
    assert.ok(text.length > 0, "something was written");
    assert.ok(!text.includes("sk-ant-api03-ALSOSHOULDNOTPERSIST"), "the prompt was redacted");
    assert.ok(!text.includes("sk-ant-api03-SHOULDNOTPERSIST"), "the reply was redacted");
  } finally {
    await ai.close();
  }
});

test("the excerpt in the ledger is capped, and the citation still resolves the whole thing", async () => {
  const long = "I will do it because " + "x".repeat(2000);
  const ai = await fakeAi(() => long);
  const h = home();
  const l = new Ledger(tmpPath());
  try {
    const r = new Registry({
      home: h, env: { K: "k" },
      onEvent: (e) => l.append({ actor: { kind: "system", name: "registry" }, action: e.action, payload: e.payload, rationale: e.rationale, source: "registry" }),
    });
    r.add({ name: "p", kind: "openai-compatible", model: "m", keyEnv: "K", baseUrl: ai.url });
    r.wake("p", "editor");
    await r.complete("p", { prompt: "q".repeat(5000) });

    const ev = l.all().find((e) => e.action === "ai.usage")!;
    assert.ok(ev.rationale!.ask!.length <= 280, "ask is capped");
    assert.ok(ev.rationale!.reason!.length <= 280, "reason is capped");
    assert.match(ev.rationale!.ask!, /…$/, "truncation is visible, not silent");

    const ex = findExchange(h, ev.rationale!.ref!.exchangeSha256!)!;
    assert.equal(ex.prompt.length, 5000, "the store keeps the untruncated original");
  } finally {
    await ai.close();
  }
});

test("every registered kind reaches the fake server in its own wire format", async () => {
  const ai = await fakeAi((p) => `saw: ${p}`);
  try {
    const kinds = [
      { kind: "anthropic" as const, path: "/v1/messages" },
      { kind: "gemini" as const, path: ":generateContent" },
      { kind: "ollama" as const, path: "/api/chat" },
      { kind: "openai-compatible" as const, path: "/v1/chat/completions" },
    ];
    for (const k of kinds) {
      const out = await callProvider(
        { name: "x", kind: k.kind, model: "m", keyEnv: "K", baseUrl: ai.url, role: "editor" },
        { prompt: "hello" },
        fetch,
        { K: "key" } as NodeJS.ProcessEnv,
      );
      assert.equal(out.text, "saw: hello", `${k.kind} round-trips`);
      assert.ok(ai.seen.some((s) => s.path.includes(k.path)), `${k.kind} used ${k.path}`);
      assert.ok(out.inputTokens > 0 && out.outputTokens > 0, `${k.kind} reports usage`);
    }
  } finally {
    await ai.close();
  }
});

test("an unknown kind is refused at registration, listing what is supported", () => {
  const r = new Registry({ home: home() });
  assert.throws(
    () => r.add({ name: "x", kind: "cohere" as any, model: "m", keyEnv: "K" }),
    /openai-compatible/,
  );
});

test("the stated reason is the first sentence, not the whole essay", () => {
  assert.equal(statedReason("Fixing the lock. It forked under load."), "Fixing the lock.");
  assert.equal(statedReason("First line only\nsecond line"), "First line only");
  assert.equal(statedReason("   "), undefined);
  assert.equal(statedReason("no punctuation here"), "no punctuation here");
});
