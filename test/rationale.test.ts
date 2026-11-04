import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRationale, readTail } from "../src/rationale.ts";

const dir = () => mkdtempSync(join(tmpdir(), "handoff-tx-"));

/** A transcript in the shape Claude Code actually writes: one content block per record, chained by parentUuid. */
function transcript(rows: object[]): string {
  const d = dir();
  const p = join(d, "t.jsonl");
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

const SESSION = "sess-1";
const PROMPT = "prompt-1";

const sample = () => transcript([
  { type: "user", uuid: "u1", parentUuid: null, promptId: PROMPT, sessionId: SESSION, message: { role: "user", content: "fix the flaky upload retry" } },
  { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: SESSION, message: { role: "assistant", content: [{ type: "thinking", text: "probably the fixed delay" }] } },
  { type: "assistant", uuid: "a2", parentUuid: "a1", sessionId: SESSION, message: { role: "assistant", content: [{ type: "text", text: "Switching to exponential backoff; the fixed delay still bursts." }] } },
  { type: "assistant", uuid: "a3", parentUuid: "a2", sessionId: SESSION, message: { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "Edit", input: { file_path: "/x/up.ts" } }] } },
  { type: "user", uuid: "u2", parentUuid: "a3", sessionId: SESSION, message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
  { type: "assistant", uuid: "a4", parentUuid: "u2", sessionId: SESSION, message: { role: "assistant", content: [{ type: "tool_use", id: "tu-2", name: "Bash", input: { command: "npm test" } }] } },
]);

test("recovers the human ask and what the AI said it was doing", () => {
  const r = readRationale({ transcriptPath: sample(), promptId: PROMPT, toolUseId: "tu-1", sessionId: SESSION });
  assert.equal(r.provenance, "cited");
  assert.equal(r.ask, "fix the flaky upload retry");
  assert.equal(r.reason, "Switching to exponential backoff; the fixed delay still bursts.");
  assert.equal(r.ref?.toolUseId, "tu-1");
  assert.equal(r.ref?.promptId, PROMPT);
});

test("takes what the AI said out loud, never its private thinking", () => {
  const p = transcript([
    { type: "user", uuid: "u1", parentUuid: null, promptId: PROMPT, message: { role: "user", content: "do the thing" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "thinking", text: "SECRET-REASONING-SHOULD-NOT-APPEAR" }] } },
    { type: "assistant", uuid: "a2", parentUuid: "a1", message: { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }] } },
  ]);
  const r = readRationale({ transcriptPath: p, promptId: PROMPT, toolUseId: "tu-1" });
  assert.equal(r.ask, "do the thing");
  assert.equal(r.reason, undefined, "it said nothing out loud, so there is no reason to quote");
  assert.ok(JSON.stringify(r).indexOf("SECRET-REASONING") === -1);
});

test("a reason stated in the same message as the call is used", () => {
  const p = transcript([
    { type: "user", uuid: "u1", parentUuid: null, promptId: PROMPT, message: { role: "user", content: "ask" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [
      { type: "text", text: "Checking the migration first." },
      { type: "tool_use", id: "tu-1", name: "Bash", input: {} },
    ] } },
  ]);
  assert.equal(readRationale({ transcriptPath: p, promptId: PROMPT, toolUseId: "tu-1" }).reason, "Checking the migration first.");
});

test("a tool result is never mistaken for the human asking something", () => {
  // tu-2 follows a tool_result; walking back must not read "ok" as the instruction
  const r = readRationale({ transcriptPath: sample(), promptId: PROMPT, toolUseId: "tu-2", sessionId: SESSION });
  assert.equal(r.ask, "fix the flaky upload retry");
  assert.notEqual(r.reason, "ok");
});

test("injected system blocks are not treated as the human ask", () => {
  const p = transcript([
    { type: "user", uuid: "u1", parentUuid: null, promptId: PROMPT, message: { role: "user", content: "<system-reminder>be careful</system-reminder>" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }] } },
  ]);
  assert.equal(readRationale({ transcriptPath: p, promptId: PROMPT, toolUseId: "tu-1" }).ask, undefined);
});

test("a missing, empty or corrupt transcript yields absent and never throws", () => {
  assert.equal(readRationale({ transcriptPath: join(dir(), "nope.jsonl"), promptId: PROMPT }).provenance, "absent");
  assert.equal(readRationale({}).provenance, "absent");

  const torn = join(dir(), "torn.jsonl");
  writeFileSync(torn, "{not json\n{\"type\":\"user\"\n\u0000\u0000\n");
  assert.equal(readRationale({ transcriptPath: torn, promptId: PROMPT, toolUseId: "tu-1" }).provenance, "absent");
});

test("the ask is cached per prompt, so a burst of calls does not re-read the transcript", () => {
  const cacheDir = dir();
  const path = sample();
  let reads = 0;
  const counting = (p: string, b: number) => { reads++; return readTail(p, b); };

  const first = readRationale({ transcriptPath: path, promptId: PROMPT, toolUseId: "tu-1", sessionId: SESSION, cacheDir, readWindow: counting });
  assert.equal(first.ask, "fix the flaky upload retry");
  const after = reads;

  // second call still needs the reason (per tool call) but must not hunt for the ask again
  const second = readRationale({ transcriptPath: path, promptId: PROMPT, toolUseId: "tu-2", sessionId: SESSION, cacheDir, readWindow: counting });
  assert.equal(second.ask, "fix the flaky upload retry", "served from cache");
  assert.ok(reads - after <= 1, "one window read, not a widening search");
});

test("tail reads are bounded and drop the torn first line", () => {
  const d = dir();
  const p = join(d, "big.jsonl");
  const rows: string[] = [];
  for (let i = 0; i < 5000; i++) rows.push(JSON.stringify({ type: "filler", uuid: "f" + i, pad: "y".repeat(200) }));
  writeFileSync(p, rows.join("\n") + "\n");
  const size = statSync(p).size;
  assert.ok(size > 512 * 1024, "fixture is bigger than one window");

  const tail = readTail(p, 64 * 1024);
  assert.ok(tail.length > 0 && tail.length < 5000, "only a slice came back");
  for (const l of tail) assert.doesNotThrow(() => JSON.parse(l), "every returned line is whole");
});

test("the window widens when the answer is older than the first window", () => {
  const d = dir();
  const p = join(d, "deep.jsonl");
  const head = [
    JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, promptId: PROMPT, message: { role: "user", content: "the original instruction" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "Starting on it." }] } }),
    JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "a1", message: { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }] } }),
  ];
  const filler: string[] = [];
  for (let i = 0; i < 4000; i++) filler.push(JSON.stringify({ type: "filler", uuid: "f" + i, pad: "z".repeat(200) }));
  writeFileSync(p, head.concat(filler).join("\n") + "\n");

  const r = readRationale({ transcriptPath: p, promptId: PROMPT, toolUseId: "tu-1" });
  assert.equal(r.ask, "the original instruction", "found by widening past the first window");
  assert.equal(r.reason, "Starting on it.");
});
