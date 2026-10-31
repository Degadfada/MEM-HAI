import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry, BudgetError } from "../src/providers.ts";
import { fakeAi } from "./fakeai.ts";

const ai = await fakeAi();
after(() => ai.close());
const env = { ANTHROPIC_API_KEY: "sk-ant-test-key-1234567890", GEMINI_API_KEY: "g-test-key" } as NodeJS.ProcessEnv;
const mk = (extra: object = {}) => {
  const events: any[] = [];
  const r = new Registry({ home: mkdtempSync(join(tmpdir(), "reg-")), env, today: () => "2026-10-31", onEvent: (e) => events.push(e), ...extra });
  r.add({ name: "claude", kind: "anthropic", model: "claude-sonnet-5-5", keyEnv: "ANTHROPIC_API_KEY", baseUrl: ai.url });
  r.add({ name: "gemini", kind: "gemini", model: "gemini-2.5-pro", keyEnv: "GEMINI_API_KEY", baseUrl: ai.url });
  r.add({ name: "llama", kind: "ollama", model: "llama3.1", baseUrl: ai.url });
  return { r, events };
};

test("all three vendors: correct wire format, auth header, system prompt and token accounting", async () => {
  const { r } = mk();
  for (const n of ["claude", "gemini", "llama"]) r.wake(n, n === "llama" ? "editor" : n === "claude" ? "steward" : "editor");
  r.wake("gemini", "steward"); r.wake("claude", "editor"); // shuffle so all three are exercised awake below
  ai.seen.length = 0;
  r.wake("claude", "steward");
  const a = await r.complete("claude", { system: "be terse", prompt: "hello" });
  assert.equal(a.text, "echo: hello");
  assert.deepEqual([a.inputTokens, a.outputTokens], [100, 50]);
  assert.equal(ai.seen[0]!.path, "/v1/messages");
  assert.equal(ai.seen[0]!.headers["x-api-key"], env.ANTHROPIC_API_KEY);
  assert.equal(ai.seen[0]!.headers["anthropic-version"], "2023-06-01");
  assert.equal(ai.seen[0]!.body.system, "be terse");

  r.wake("gemini", "editor");
  const g = await r.complete("gemini", { system: "sys", prompt: "hi gemini" });
  assert.equal(g.text, "echo: hi gemini");
  assert.match(ai.seen[1]!.path, /\/v1beta\/models\/gemini-2\.5-pro:generateContent/);
  assert.equal(ai.seen[1]!.headers["x-goog-api-key"], "g-test-key");
  assert.ok(!ai.seen[1]!.path.includes("g-test-key"), "key must never appear in the URL");
  assert.equal(ai.seen[1]!.body.systemInstruction.parts[0].text, "sys");

  // gemini took the editor role; llama (asleep) must refuse, then work once woken as editor, displacing gemini
  await assert.rejects(r.complete("llama", { prompt: "x" }), /asleep/);
  r.wake("llama", "editor");
  const l = await r.complete("llama", { system: "s", prompt: "hi llama" });
  assert.equal(l.text, "echo: hi llama");
  assert.equal(ai.seen[2]!.path, "/api/chat");
  assert.equal(ai.seen[2]!.body.stream, false);
  assert.equal(r.get("gemini").role, "asleep");
});

test("at most one editor and one steward awake; waking displaces and is audited", () => {
  const { r, events } = mk();
  r.wake("claude", "steward");
  r.wake("gemini", "editor");
  assert.equal(r.awake().length, 2);
  const res = r.wake("llama", "steward");
  assert.deepEqual(res.slept, ["claude"]);
  assert.equal(r.awake().length, 2);
  assert.equal(r.holder("steward")!.name, "llama");
  r.sleep("gemini");
  assert.equal(r.awake().length, 1);
  assert.deepEqual(events.map((e) => e.action), ["provider.wake", "provider.wake", "provider.wake", "provider.sleep"]);
});

test("state persists across reloads; keys are never written to disk", () => {
  const home = mkdtempSync(join(tmpdir(), "reg-"));
  const r = new Registry({ home, env });
  r.add({ name: "claude", kind: "anthropic", model: "m", keyEnv: "ANTHROPIC_API_KEY" });
  r.wake("claude", "steward");
  const again = new Registry({ home, env });
  assert.equal(again.holder("steward")!.name, "claude");
  const disk = readFileSync(join(home, "providers.json"), "utf8");
  assert.ok(!disk.includes(env.ANTHROPIC_API_KEY!));
  assert.match(disk, /ANTHROPIC_API_KEY/);
});

test("daily token budget: refuses before spending, counts real usage, resets the next day", async () => {
  let day = "2026-10-31";
  const { r } = mk({ today: () => day });
  r.wake("claude", "steward");
  r.setBudget(400);
  await r.complete("claude", { prompt: "a", maxTokens: 100 });       // uses 150
  assert.equal(r.usedToday(), 150);
  await r.complete("claude", { prompt: "b", maxTokens: 100 });       // 300
  await assert.rejects(r.complete("claude", { prompt: "c", maxTokens: 200 }), BudgetError); // 300 + ~201 > 400
  assert.equal(ai.seen.filter((s) => s.body.messages?.[0]?.content === "c").length, 0, "no request may be sent once over budget");
  day = "2026-11-01";
  assert.equal(r.usedToday(), 0);
  await r.complete("claude", { prompt: "d", maxTokens: 50 });
});

test("validation: names, key env var must be a NAME not a key, https required off-localhost, unknown provider", () => {
  const { r } = mk();
  assert.throws(() => r.add({ name: "Bad Name", kind: "ollama", model: "m" }), /provider name/);
  assert.throws(() => r.add({ name: "claude", kind: "ollama", model: "m" }), /already exists/);
  assert.throws(() => r.add({ name: "x1", kind: "anthropic", model: "m" }), /keyEnv required/);
  assert.throws(() => r.add({ name: "x2", kind: "anthropic", model: "m", keyEnv: "sk-ant-api03-abcdef" }), /variable name/);
  assert.throws(() => r.add({ name: "x3", kind: "ollama", model: "m", baseUrl: "http://evil.example.com" }), /https/);
  assert.throws(() => r.wake("ghost", "steward"), /no such provider/);
  assert.throws(() => r.setBudget(-1), />= 0/);
});

test("errors never leak the key; missing key is reported by variable name", async () => {
  const { r } = mk();
  r.wake("claude", "steward");
  ai.failWith(500);
  await assert.rejects(r.complete("claude", { prompt: "x" }), (e: Error) => /HTTP 500/.test(e.message) && !e.message.includes(env.ANTHROPIC_API_KEY!));
  ai.failWith(null);
  const r2 = new Registry({ home: mkdtempSync(join(tmpdir(), "reg-")), env: {} });
  r2.add({ name: "claude", kind: "anthropic", model: "m", keyEnv: "ANTHROPIC_API_KEY", baseUrl: ai.url });
  r2.wake("claude", "steward");
  await assert.rejects(r2.complete("claude", { prompt: "x" }), /ANTHROPIC_API_KEY is empty/);
  assert.equal(r2.status().providers[0]!.keySet, false);
});

test("askSteward needs an awake steward", async () => {
  const { r } = mk();
  await assert.rejects(r.askSteward({ prompt: "x" }), /no steward is awake/);
});
