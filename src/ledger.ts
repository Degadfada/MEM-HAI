import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonical, sha256 } from "./canonical.ts";
import { redactDeep } from "./redact.ts";
import type { EventInput, LedgerEvent, LedgerHeader } from "./types.ts";

const SEED_COUNT = 8;
const rand32 = () => randomBytes(4).readUInt32BE(0);

// Several processes write this file: the Claude Code hook, the VS Code extension host, the CLI and
// the dashboard. Each one computes `seq` and `prev` from the current tail, so two appends in the
// same instant used to produce two events claiming the same position and fork the chain. Everything
// below exists to make read-tail-then-append one atomic step between processes.
const LOCK_WAIT_MS = 4000;
const LOCK_STALE_MS = 15_000;

/** Sleep without a busy loop, in sync code. */
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/**
 * Hold `<path>.lock` for the duration of fn. Exclusive between processes, and used by every
 * operation that reads the tail then writes -- appending AND repairing. A repair that did not hold
 * this could be overtaken mid-rewrite by a live writer and lose or re-fork events.
 * Steals a lock whose owner evidently died.
 */
export function withFileLock<T>(path: string, fn: () => T): T {
  const lock = path + ".lock";
  const until = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (e) {
      // Windows reports a contended or delete-pending lock as EPERM/EACCES, not EEXIST.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch { /* someone else cleared it first */ }
      if (Date.now() > until) throw new Error(`ledger is locked by another process: ${lock}`);
      sleepSync(15 + Math.floor(Math.random() * 25));
    }
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd!); } catch { /* already closed */ }
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}


export interface VerifyResult {
  ok: boolean;
  events: number;
  error?: string;
  atLine?: number;
}

export interface RepairResult {
  ok: boolean;
  events: number;
  reordered: number;
  backup: string;
  originalSha256: string;
  note: string;
}

export class Ledger {
  readonly path: string;
  header!: LedgerHeader;
  private events: LedgerEvent[] = [];
  private ids = new Set<string>();
  private reversed = new Set<string>();
  private loadedBytes = 0;

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
    const raw = readFileSync(this.path, "utf8");
    this.loadedBytes = Buffer.byteLength(raw);
    this.events = [];
    this.ids.clear();
    this.reversed.clear();
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) throw new Error("ledger file is empty");
    this.header = JSON.parse(lines[0]!);
    for (const line of lines.slice(1)) {
      const e = JSON.parse(line) as LedgerEvent;
      this.events.push(e);
      this.ids.add(e.id);
      if (e.reverses) this.reversed.add(e.reverses);
    }
  }

  private withLock<T>(fn: () => T): T {
    return withFileLock(this.path, fn);
  }

  /** Pick up events other processes appended since we last read. Cheap when nothing changed. */
  private refresh(): void {
    try {
      if (statSync(this.path).size !== this.loadedBytes) this.load();
    } catch { /* file vanished: keep what we have rather than throwing on a write */ }
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
    return this.withLock(() => {
      // Another writer may have moved the tail while we waited for the lock.
      this.refresh();
      return this.appendLocked(input);
    });
  }

  private appendLocked(input: EventInput): LedgerEvent {
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

    // Default, not a guess: an actor nobody named is unattributed; one that named itself is exact.
    // Callers that deduced the author (the file watcher) pass "inferred" explicitly.
    const confidence = input.confidence ?? (input.actor.kind === "unknown" ? "unattributed" : "exact");

    const prev = this.events.length ? this.events[this.events.length - 1]!.hash : this.header.genesis;
    const body: Omit<LedgerEvent, "hash"> = {
      type: "event",
      id: this.newId(),
      seq: this.events.length,
      ts: input.ts ?? new Date().toISOString(),
      delta: input.reverses ? -1 : 1,
      actor: clean.actor,
      action: clean.action,
      confidence,
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

    const line = canonical(event) + "\n";
    appendFileSync(this.path, line);
    this.loadedBytes += Buffer.byteLength(line);
    this.events.push(event);
    this.ids.add(event.id);
    if (event.reverses) this.reversed.add(event.reverses);
    return event;
  }

  reverse(id: string, by: EventInput["actor"], summary?: string): LedgerEvent {
    return this.append({ actor: by, action: "reversal", reverses: id, summary: summary ?? `undo ${id}` });
  }

  /** Re-reads the file from disk and checks every hash link. */
  /**
   * Re-chain a ledger whose links were broken by concurrent writers.
   *
   * This cannot be a silent fix. Re-linking changes every `prev`, and therefore every `hash`, after
   * the first break: the original signatures cannot be preserved. So we keep the original file
   * untouched beside the repaired one, record its SHA-256 in a `ledger.repair` event, and lose no
   * event. Events are ordered by timestamp, which is what the forked writers actually disagreed on.
   */
  static repair(path: string, by: { kind: "human" | "system"; name: string }): RepairResult {
    // The rewrite holds the lock, so a live writer cannot be overtaken mid-file. The repair record
    // is appended afterwards, outside the lock, because append() takes the lock itself and it is
    // not reentrant -- safe, because the chain is already valid again by then.
    const staged = withFileLock(path, () => Ledger.rechain(path));
    const l = new Ledger(path);
    const note = `re-chained ${staged.events} event(s) after a concurrent-write fork; ${staged.reordered} moved into timestamp order; original kept at ${staged.backup} (sha256 ${staged.originalSha256.slice(0, 16)})`;
    l.append({
      actor: by,
      action: "ledger.repair",
      summary: note,
      source: "manual",
      payload: { originalSha256: staged.originalSha256, backup: staged.backup, events: staged.events, reordered: staged.reordered },
    });
    const v = Ledger.verify(path);
    return { ok: v.ok, events: staged.events, reordered: staged.reordered, backup: staged.backup, originalSha256: staged.originalSha256, note };
  }

  /** Read, back up and re-link. Must be called holding the lock. */
  private static rechain(path: string): { events: number; reordered: number; backup: string; originalSha256: string } {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (!lines.length) throw new Error("ledger file is empty");
    const header = JSON.parse(lines[0]!) as LedgerHeader;
    const events = lines.slice(1).map((l) => JSON.parse(l) as LedgerEvent);

    const before = events.map((e) => e.id);
    const ordered = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.seq - b.seq);
    const reordered = ordered.reduce((n, e, i) => (e.id === before[i] ? n : n + 1), 0);

    const originalSha256 = sha256(raw);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${path}.broken-${stamp}`;
    writeFileSync(backup, raw);

    // Re-link from the genesis hash, keeping every event body apart from seq/prev/hash.
    let prev = header.genesis;
    const out: string[] = [canonical(header)];
    for (let i = 0; i < ordered.length; i++) {
      const { hash: _h, prev: _p, seq: _s, ...rest } = ordered[i]!;
      const body = { ...rest, seq: i, prev } as Omit<LedgerEvent, "hash">;
      const event = { ...body, hash: sha256(canonical(body)) } as LedgerEvent;
      prev = event.hash;
      out.push(canonical(event));
    }
    writeFileSync(path, out.join("\n") + "\n");

    return { events: ordered.length, reordered, backup, originalSha256 };
  }

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
