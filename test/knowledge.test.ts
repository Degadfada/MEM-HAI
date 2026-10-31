import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, chunkText, ruleCards } from "../src/knowledge.ts";

const dir = () => mkdtempSync(join(tmpdir(), "kn-"));
const BOOK = `
Chapter 1. Prompts

Always state the goal and the acceptance criteria before describing the code you want changed. A model that knows when it is done stops sooner and drifts less.

Avoid pasting whole files when only one function matters, because irrelevant context dilutes the instructions that count.

This sentence has no guidance at all and is merely descriptive of the weather in spring.

Chapter 2. Testing

Prefer writing the failing test first, then the smallest change that makes it pass. Never ask for a rewrite when a diff will do.
`.trim();

test("chunking keeps paragraphs together and caps chunk size", () => {
  const ch = chunkText(Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ` + "word ".repeat(60)).join("\n\n"), 1000);
  assert.ok(ch.length > 5);
  assert.ok(ch.every((c) => c.length <= 1500));
  assert.deepEqual(chunkText(""), []);
});

test("rule extractor keeps guidance sentences and drops descriptive ones", () => {
  const cards = ruleCards(BOOK, "book", 0, 10);
  assert.ok(cards.some((c) => /acceptance criteria/.test(c.technique)));
  assert.ok(cards.some((c) => /failing test first/.test(c.technique)));
  assert.ok(!cards.some((c) => /weather/.test(c.technique)));
  assert.ok(cards.every((c) => c.technique.length <= 280 && c.via === "rules"));
});

test("ingest without an LLM; same document is not ingested twice; cards persist", async () => {
  const d = dir();
  const s = new KnowledgeStore(d);
  const r = await s.ingest("book", BOOK);
  assert.ok(r.added >= 3);
  assert.equal(r.fallbackChunks, r.chunks);
  assert.equal((await s.ingest("book-again", BOOK)).skipped, true);
  assert.equal(new KnowledgeStore(d).cards.length, s.cards.length);
});

test("ingest with an LLM uses its JSON, falls back per chunk on junk, and stops spending when the budget error appears", async () => {
  let n = 0;
  const ask = async () => {
    n++;
    if (n === 1) return 'Sure! ```json\n[{"title":"Define done","technique":"State acceptance criteria up front so the model knows when to stop.","when":"before any coding task","tags":["Prompting","criteria"]}]\n```';
    if (n === 2) return "I could not find anything, sorry";
    throw new Error("daily token budget reached");
  };
  const big = Array.from({ length: 6 }, (_, i) => `Section ${i}. You should always keep context small number ${i}. ` + "filler words here ".repeat(120)).join("\n\n");
  const s = new KnowledgeStore(dir());
  const r = await s.ingest("big", big, { ask, perChunk: 1 });
  assert.equal(r.llmChunks, 1);
  assert.ok(r.fallbackChunks >= 1);
  assert.equal(n, 3, "after the budget error no more LLM calls are made");
  const c = s.cards.find((x) => x.via === "llm")!;
  assert.deepEqual([c.title, c.tags], ["Define done", ["prompting", "criteria"]]);
});

test("BM25 finds the relevant card first and returns nothing for unrelated queries", async () => {
  const s = new KnowledgeStore(dir());
  await s.ingest("book", BOOK);
  assert.match(s.search("write the failing test before the change")[0]!.technique, /failing test first/);
  assert.match(s.search("acceptance criteria drift")[0]!.technique, /acceptance criteria/);
  assert.equal(s.search("quantum chromodynamics").length, 0);
  assert.equal(new KnowledgeStore(dir()).search("anything").length, 0);
});

test("a hostile LLM reply cannot inject oversized or malformed cards", async () => {
  const s = new KnowledgeStore(dir());
  await s.ingest("x", "Some text that is long enough to be a chunk. ".repeat(10), { ask: async () => JSON.stringify([{ technique: "x".repeat(5000), title: "t".repeat(500) }, { technique: 5 }, "str", null]) });
  const c = s.cards.find((x) => x.via === "llm")!;
  assert.ok(c.technique.length <= 280 && c.title.length <= 60);
  assert.equal(s.cards.filter((x) => x.via === "llm").length, 1);
});
