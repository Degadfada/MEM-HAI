// Technique cards distilled from books/notes, with BM25 retrieval. Cards cite their source chunk.
// With a steward awake, cards are written by the LLM (paraphrased). Without one, a deterministic extractor keeps
// short guidance-bearing sentences. Either way a card is capped at 280 chars: these are working notes, not copies of the book.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./canonical.ts";

export interface Card {
  id: string;
  title: string;
  technique: string;
  when: string;
  tags: string[];
  source: { doc: string; chunk: number };
  via: "llm" | "rules";
}
export type Ask = (system: string, prompt: string) => Promise<string>;

const CUE = /\b(should|must|always|never|avoid|prefer|ensure|make sure|rather than|instead of|best practice|rule of thumb|trade-?off|do not|don't|first,|then,|consider)\b/gi;
const STOP = new Set("a an the and or of to in on for with is are was were be been it this that as at by from not but if so do does you your we our can will".split(" "));
const tok = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function chunkText(text: string, size = 1800): string[] {
  const paras = text.replace(/\r/g, "").split(/\n{2,}/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length > size) { out.push(cur); cur = ""; }
    cur += (cur ? " " : "") + p;
    while (cur.length > size * 1.5) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur) out.push(cur);
  return out;
}

export function ruleCards(chunk: string, doc: string, idx: number, max = 3): Card[] {
  const sentences = chunk.match(/[^.!?]+[.!?]/g) ?? [];
  return sentences
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 260)
    .map((s) => ({ s, score: (s.match(CUE) ?? []).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.length - b.s.length)
    .slice(0, max)
    .map(({ s }) => ({ id: sha256(s.toLowerCase()).slice(0, 12), title: clip(s.split(/[,;:]/)[0]!, 60), technique: clip(s, 280), when: "", tags: tok(s).slice(0, 5), source: { doc, chunk: idx }, via: "rules" as const }));
}

function parseLlmCards(reply: string, doc: string, idx: number): Card[] | null {
  const a = reply.indexOf("["), b = reply.lastIndexOf("]");
  if (a < 0 || b <= a) return null;
  let arr: unknown;
  try { arr = JSON.parse(reply.slice(a, b + 1)); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const out: Card[] = [];
  for (const x of arr.slice(0, 5)) {
    const o = x as Record<string, unknown>;
    if (typeof o?.technique !== "string" || o.technique.trim().length < 15) continue;
    const technique = clip(o.technique.trim(), 280);
    out.push({
      id: sha256(technique.toLowerCase()).slice(0, 12),
      title: clip(String(o.title ?? technique.split(/[,;:.]/)[0]), 60),
      technique, when: clip(String(o.when ?? ""), 120),
      tags: Array.isArray(o.tags) ? o.tags.map((t) => String(t).toLowerCase().slice(0, 24)).slice(0, 6) : [],
      source: { doc, chunk: idx }, via: "llm",
    });
  }
  return out.length ? out : null;
}

const SYSTEM = "You extract practical, reusable techniques from a passage of a book about building software or working with AI. Paraphrase in your own words; never copy sentences. Reply with ONLY a JSON array (max 4 items) of {\"title\",\"technique\",\"when\",\"tags\"}: technique = one imperative sentence under 240 chars; when = the situation it applies to; tags = 2-5 lowercase keywords. If the passage has no actionable technique, reply [].";

export class KnowledgeStore {
  readonly dir: string;
  cards: Card[] = [];
  private docs = new Set<string>();
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "cards.jsonl");
    if (existsSync(f))
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if (r.doc_sha) this.docs.add(r.doc_sha); else this.cards.push(r);
      }
  }

  /** Returns how many new cards were added. A document already ingested (same bytes) is skipped. */
  async ingest(doc: string, text: string, opts: { ask?: Ask; maxChunks?: number; perChunk?: number } = {}): Promise<{ added: number; chunks: number; skipped: boolean; llmChunks: number; fallbackChunks: number }> {
    const sha = sha256(text);
    if (this.docs.has(sha)) return { added: 0, chunks: 0, skipped: true, llmChunks: 0, fallbackChunks: 0 };
    const chunks = chunkText(text).slice(0, opts.maxChunks ?? 400);
    const have = new Set(this.cards.map((c) => c.id));
    let added = 0, llm = 0, fb = 0;
    for (let i = 0; i < chunks.length; i++) {
      let cards: Card[] | null = null;
      if (opts.ask) {
        try { cards = parseLlmCards(await opts.ask(SYSTEM, chunks[i]!), doc, i); if (cards) llm++; } catch (e) {
          if (/budget/i.test(String((e as Error).message))) opts = { ...opts, ask: undefined }; // stop spending, finish with rules
        }
      }
      if (!cards) { cards = ruleCards(chunks[i]!, doc, i, opts.perChunk ?? 3); fb++; }
      for (const c of cards) if (!have.has(c.id)) { have.add(c.id); this.cards.push(c); appendFileSync(join(this.dir, "cards.jsonl"), JSON.stringify(c) + "\n"); added++; }
    }
    appendFileSync(join(this.dir, "cards.jsonl"), JSON.stringify({ doc_sha: sha, doc, at: new Date().toISOString() }) + "\n");
    this.docs.add(sha);
    return { added, chunks: chunks.length, skipped: false, llmChunks: llm, fallbackChunks: fb };
  }

  /** BM25 over title + technique + when + tags. */
  search(query: string, k = 5): Array<Card & { score: number }> {
    const q = tok(query);
    if (!q.length || !this.cards.length) return [];
    const docs = this.cards.map((c) => tok(`${c.title} ${c.technique} ${c.when} ${c.tags.join(" ")}`));
    const N = docs.length, avg = docs.reduce((n, d) => n + d.length, 0) / N || 1;
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    const k1 = 1.4, b = 0.75;
    return this.cards
      .map((c, i) => {
        const tf = new Map<string, number>();
        for (const t of docs[i]!) tf.set(t, (tf.get(t) ?? 0) + 1);
        let score = 0;
        for (const t of new Set(q)) {
          const f = tf.get(t) ?? 0;
          if (!f) continue;
          const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
          score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i]!.length) / avg)));
        }
        return { ...c, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, k);
  }
}
