import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonical, sha256 } from "./canonical.ts";
import { redactDeep } from "./redact.ts";
import type { EventInput, LedgerEvent, LedgerHeader } from "./types.ts";

const SEED_COUNT = 8;
const rand32 = () => randomBytes(4).readUInt32BE(0);

export interface VerifyResult {
  ok: boolean;
  events: number;
  error?: string;
  atLine?: number;
}

export class Ledger {
  readonly path: string;
  header!: LedgerHeader;
  private events: LedgerEvent[] = [];
  private ids = new Set<string>();
  private reversed = new Set<string>();

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) this.load();
    else this.init();
  }

  private init() {
    mkdirSync(dirname(this.path), { recursive: true });
    const body = {
      type: "header" as const,
      version: 1 as const,
      created: new Date().toISOString(),
      seeds: {
        countMin: Array.from({ length: SEED_COUNT }, rand32),
        minHash: Array.from({ length: SEED_COUNT * 4 }, rand32),
      },
    };
    const genesis = sha256(canonical(body));
    this.header = { ...body, genesis, hash: genesis };
    writeFileSync(this.path, canonical(this.header) + "\n", { flag: "wx" });
  }

  private load() {
    const lines = readFileSync(this.path, "utf8").split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) throw new Error("ledger file is empty");
    this.header = JSON.parse(lines[0]!);
    for (const line of lines.slice(1)) {
      const e = JSON.parse(line) as LedgerEvent;
      this.events.push(e);
      this.ids.add(e.id);
      if (e.reverses) this.reversed.add(e.reverses);
    }
  }

  private newId(): string {
    // 64 random bits: collision probability for n events <= n^2 / 2^65.
    for (let i = 0; i < 8; i++) {
      const id = randomBytes(8).toString("hex");
      if (!this.ids.has(id)) return id;
    }
    throw new Error("could not generate a unique event id");
  }

  get length(): number {
    return this.events.length;
  }

  all(): readonly LedgerEvent[] {
    return this.events;
  }

  get(id: string): LedgerEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  isReversed(id: string): boolean {
    return this.reversed.has(id);
  }

  append(input: EventInput): LedgerEvent {
    if (input.reverses) {
      const target = this.get(input.reverses);
      if (!target) throw new Error(`cannot reverse unknown event ${input.reverses}`);
      if (target.delta !== 1) throw new Error("cannot reverse a reversal");
      if (this.reversed.has(input.reverses)) throw new Error(`event ${input.reverses} already reversed`);
    }

    // Redact BEFORE hashing and writing, so the raw secret never reaches disk.
    const { value: clean, count, kinds } = redactDeep({
      summary: input.summary,
      target: input.target,
      payload: input.payload,
      actor: input.actor,
      action: input.action,
      aiInUse: input.aiInUse,
      source: input.source,
    });

    const prev = this.events.length ? this.events[this.events.length - 1]!.hash : this.header.genesis;
    const body: Omit<LedgerEvent, "hash"> = {
      type: "event",
      id: this.newId(),
      seq: this.events.length,
      ts: input.ts ?? new Date().toISOString(),
      delta: input.reverses ? -1 : 1,
      actor: clean.actor,
      action: clean.action,
      aiInUse: clean.aiInUse,
      target: clean.target,
      summary: clean.summary,
      payload: clean.payload,
      approval: input.approval ?? { status: "unknown" },
      source: clean.source,
      reverses: input.reverses,
      redactions: count ? { count, kinds } : undefined,
      prev,
    };
    const event = { ...body, hash: sha256(canonical(body)) } as LedgerEvent;

    appendFileSync(this.path, canonical(event) + "\n");
    this.events.push(event);
    this.ids.add(event.id);
    if (event.reverses) this.reversed.add(event.reverses);
    return event;
  }

  reverse(id: string, by: EventInput["actor"], summary?: string): LedgerEvent {
    return this.append({ actor: by, action: "reversal", reverses: id, summary: summary ?? `undo ${id}` });
  }

  /** Re-reads the file from disk and checks every hash link. */
  static verify(path: string): VerifyResult {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return { ok: false, events: 0, error: "empty file" };
    let header: LedgerHeader;
    try {
      header = JSON.parse(lines[0]!);
    } catch {
      return { ok: false, events: 0, error: "header is not valid JSON", atLine: 1 };
    }
    const { hash: _h, genesis: _g, ...hbody } = header;
    if (sha256(canonical(hbody)) !== header.genesis || header.hash !== header.genesis)
      return { ok: false, events: 0, error: "header hash mismatch", atLine: 1 };

    let prev = header.genesis;
    const ids = new Set<string>();
    const live = new Map<string, number>(); // id -> net count, must stay 0..1
    for (let i = 1; i < lines.length; i++) {
      let e: LedgerEvent;
      try {
        e = JSON.parse(lines[i]!);
      } catch {
        return { ok: false, events: i - 1, error: "event is not valid JSON", atLine: i + 1 };
      }
      if (e.seq !== i - 1) return { ok: false, events: i - 1, error: `bad seq ${e.seq}`, atLine: i + 1 };
      if (e.prev !== prev) return { ok: false, events: i - 1, error: "chain broken (prev mismatch)", atLine: i + 1 };
      const { hash, ...body } = e;
      if (sha256(canonical(body)) !== hash)
        return { ok: false, events: i - 1, error: "content hash mismatch (event was altered)", atLine: i + 1 };
      if (ids.has(e.id)) return { ok: false, events: i - 1, error: "duplicate id", atLine: i + 1 };
      ids.add(e.id);
      if (e.reverses) {
        const n = (live.get(e.reverses) ?? 0) + e.delta;
        if (!live.has(e.reverses) || n < 0)
          return { ok: false, events: i - 1, error: "reversal violates strict turnstile", atLine: i + 1 };
        live.set(e.reverses, n);
      } else live.set(e.id, 1);
      prev = hash;
    }
    return { ok: true, events: lines.length - 1 };
  }
}
