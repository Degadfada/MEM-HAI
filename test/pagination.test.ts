import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";
import { startServer } from "../src/server.ts";
import { tmpPath } from "./helpers.ts";

const path = tmpPath();
const home = mkdtempSync(join(tmpdir(), "handoff-home-"));
const l = new Ledger(path);

// 1,000 events is past every page size in play, so "walk back to the very first one" is a real walk.
const TOTAL = 1000;
for (let i = 0; i < TOTAL; i++) {
  l.append({
    actor: i % 3 === 0 ? { kind: "ai", name: "copilot" } : { kind: "human", name: "idahosa" },
    action: i % 5 === 0 ? "command.run" : "file.edit",
    target: `src/f${i}.ts`,
    ...(i % 2 === 0 ? { rationale: { provenance: "declared" as const, reason: `because ${i}` } } : {}),
  });
}

const srv = await startServer({ ledgerPath: path, projectRoot: mkdtempSync(join(tmpdir(), "proj-")), home });
after(() => srv.close());

const api = async (p: string, init: RequestInit = {}) => {
  const r = await fetch(`http://127.0.0.1:${srv.port}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${srv.token}`, "content-type": "application/json", "x-handoff": "1" },
  });
  return { status: r.status, body: await r.json() as any };
};

test("paging back from the newest reaches the very first event, seeing each exactly once", async () => {
  const seen = new Set<number>();
  let before: number | null = null;
  let pages = 0;

  for (;;) {
    const q = before === null ? "/api/events?limit=100" : `/api/events?limit=100&before=${before}`;
    const { status, body } = await api(q);
    assert.equal(status, 200);
    assert.equal(body.total, TOTAL);
    pages++;
    for (const e of body.events) {
      assert.ok(!seen.has(e.seq), `seq ${e.seq} came back twice`);
      seen.add(e.seq);
    }
    if (body.nextBefore === null) break;
    before = body.nextBefore;
    assert.ok(pages < 50, "pagination did not terminate");
  }

  assert.equal(seen.size, TOTAL, "every event was reachable");
  assert.ok(seen.has(0), "including the very first memory logged");
  assert.equal(pages, 10);
});

test("pages come back newest first", async () => {
  const { body } = await api("/api/events?limit=10");
  const seqs = body.events.map((e: any) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a));
  assert.equal(seqs[0], TOTAL - 1);
});

test("filters compose with pagination without losing or repeating rows", async () => {
  const collect = async (q: string) => {
    const out: any[] = [];
    let before: number | null = null;
    for (;;) {
      const { body } = await api(before === null ? q : `${q}&before=${before}`);
      out.push(...body.events);
      if (body.nextBefore === null) break;
      before = body.nextBefore;
    }
    return out;
  };

  const ai = await collect("/api/events?limit=37&actor=copilot");
  assert.equal(ai.length, Math.ceil(TOTAL / 3));
  assert.ok(ai.every((e) => e.actor.name === "copilot"));
  assert.equal(new Set(ai.map((e) => e.seq)).size, ai.length);

  const cmds = await collect("/api/events?limit=50&action=command.run");
  assert.equal(cmds.length, TOTAL / 5);

  const bare = await collect("/api/events?limit=64&provenance=absent");
  assert.equal(bare.length, TOTAL / 2, "half were written without a reason");
});

test("a bad cursor is refused rather than quietly returning the newest page", async () => {
  assert.equal((await api("/api/events?before=banana")).status, 400);
});

test("the unexplained backlog is pageable and counts the whole backlog, not the page", async () => {
  const first = await api("/api/why?limit=25");
  assert.equal(first.status, 200);
  assert.equal(first.body.events.length, 25);
  assert.equal(first.body.unexplained, TOTAL / 2, "the count is the backlog, not what fits on a page");
  assert.ok(first.body.events.every((e: any) => !e.rationale || e.rationale.provenance === "absent"));

  const seen = new Set<number>();
  let before: number | null = null;
  for (;;) {
    const { body } = await api(before === null ? "/api/why?limit=200" : `/api/why?limit=200&before=${before}`);
    for (const e of body.events) seen.add(e.seq);
    if (body.nextBefore === null) break;
    before = body.nextBefore;
  }
  assert.equal(seen.size, TOTAL / 2);
});

test("annotating an unexplained action appends a reason rather than rewriting history", async () => {
  const { body: page } = await api("/api/why?limit=1");
  const target = page.events[0];
  const before = new Ledger(path).get(target.id)!;

  const res = await api("/api/why", { method: "POST", body: JSON.stringify({ id: target.id, reason: "needed for the Gwarinpa pack", by: "idahosa" }) });
  assert.equal(res.status, 200);

  const fresh = new Ledger(path);
  const after = fresh.get(target.id)!;
  assert.equal(after.hash, before.hash, "the original event is untouched");

  const added = fresh.all().find((e) => e.action === "reason.added" && e.target === target.id)!;
  assert.ok(added, "the reason is a new event citing the old one");
  assert.equal(added.rationale?.reason, "needed for the Gwarinpa pack");
  assert.equal(Ledger.verify(path).ok, true, "chain still intact");
});

test("a single event resolves with its rationale", async () => {
  const { body: page } = await api("/api/events?limit=1");
  const { status, body } = await api(`/api/event?id=${page.events[0].id}`);
  assert.equal(status, 200);
  assert.equal(body.id, page.events[0].id);
  assert.equal((await api("/api/event?id=deadbeef")).status, 404);
});

test("the day index is pageable too", async () => {
  const { body } = await api("/api/days?limit=5");
  assert.ok(Array.isArray(body.days));
  assert.ok(body.total >= 1);
  assert.ok("nextBefore" in body);
});
