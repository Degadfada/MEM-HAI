// Retention, without pretending something never happened.
//
// A hash-chained append-only log cannot have rows deleted out of the middle, and appending a
// reversal per row would double the file. So compaction works like repair does: the noise is moved
// to an archive file, the remainder is re-chained, the original is kept untouched beside it, and the
// operation is itself recorded as an event naming the counts and the original's sha256.
//
// Nothing is destroyed and nothing is hidden: the archive is a readable ledger of its own, and the
// chain says a compaction happened.
//
// The need is real: on one project 12,230 of 13,136 events were a running dev server rewriting its
// SQLite file. That is the app working, not work anybody did, and it buried the actual record.

import { readFileSync, writeFileSync } from "node:fs";
import { canonical, sha256 } from "./canonical.ts";
import { Ledger, withFileLock } from "./ledger.ts";
import type { LedgerEvent, LedgerHeader } from "./types.ts";

/** Tooling churn: files a program rewrites while it runs. */
export const NOISE_TARGET = /(\.(db|sqlite|sqlite3|lock|log|tmp|swp|pyc)$|-(wal|shm|journal)$|(^|[\\/])(\.DS_Store|Thumbs\.db)$)/i;

/**
 * An event may be archived only if it carries no part of the record worth keeping.
 *
 * Deliberately strict, because the cost of a wrong answer is asymmetric: archiving real history to
 * save space would defeat the point of the system, while leaving noise behind merely wastes bytes.
 * Anything attributed to a named actor, anything explained, anything approved or denied, anything
 * reversed or reversing, and every non-file action are all kept.
 */
export function isArchivable(e: LedgerEvent, target: RegExp): boolean {
  if (!e.action.startsWith("file.")) return false;          // rules, decisions, contracts, dispatches
  if (e.actor.kind !== "unknown") return false;              // somebody owned it
  if (e.confidence && e.confidence !== "unattributed") return false;
  if (e.rationale && e.rationale.provenance !== "absent") return false; // it explains itself
  if (e.approval && e.approval.status !== "unknown") return false;
  if (e.delta !== 1 || e.reverses) return false;             // part of an undo
  if (!e.target) return false;
  return target.test(e.target);
}

export interface CompactPlan {
  total: number;
  archivable: number;
  keep: number;
  /** The noisiest targets, so you can see what would go before it goes. */
  topTargets: { target: string; count: number }[];
}

export function planCompaction(path: string, target: RegExp = NOISE_TARGET): CompactPlan {
  const events = new Ledger(path).all();
  const counts = new Map<string, number>();
  let archivable = 0;
  for (const e of events) {
    if (!isArchivable(e, target)) continue;
    archivable++;
    counts.set(e.target!, (counts.get(e.target!) ?? 0) + 1);
  }
  return {
    total: events.length,
    archivable,
    keep: events.length - archivable,
    topTargets: [...counts.entries()]
      .map(([t, count]) => ({ target: t, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}

export interface CompactResult {
  ok: boolean;
  archived: number;
  kept: number;
  archive: string;
  backup: string;
  originalSha256: string;
  note: string;
}

export function compact(
  path: string,
  by: { kind: "human" | "system"; name: string },
  target: RegExp = NOISE_TARGET,
): CompactResult {
  const staged = withFileLock(path, () => {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (!lines.length) throw new Error("ledger file is empty");
    const header = JSON.parse(lines[0]!) as LedgerHeader;
    const events = lines.slice(1).map((l) => JSON.parse(l) as LedgerEvent);

    const keep: LedgerEvent[] = [];
    const archive: LedgerEvent[] = [];
    for (const e of events) (isArchivable(e, target) ? archive : keep).push(e);
    if (!archive.length) return null;

    const originalSha256 = sha256(raw);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${path}.pre-compact-${stamp}`;
    const archivePath = `${path}.archive-${stamp}.jsonl`;
    writeFileSync(backupPath, raw);

    // The archive keeps the same header, so it opens as a ledger in its own right. Its events keep
    // their original seq and hashes: it is evidence, not a working log.
    writeFileSync(archivePath, [canonical(header), ...archive.map((e) => canonical(e))].join("\n") + "\n");

    // Re-chain what remains. Every later hash necessarily changes, which is why the original stays.
    let prev = header.genesis;
    const out: string[] = [canonical(header)];
    for (let i = 0; i < keep.length; i++) {
      const { hash: _h, prev: _p, seq: _s, ...rest } = keep[i]!;
      const body = { ...rest, seq: i, prev } as Omit<LedgerEvent, "hash">;
      const ev = { ...body, hash: sha256(canonical(body)) } as LedgerEvent;
      prev = ev.hash;
      out.push(canonical(ev));
    }
    writeFileSync(path, out.join("\n") + "\n");
    return { archived: archive.length, kept: keep.length, archivePath, backupPath, originalSha256 };
  });

  if (!staged) {
    return { ok: true, archived: 0, kept: new Ledger(path).length, archive: "", backup: "", originalSha256: "", note: "nothing to compact" };
  }

  Ledger.forget(path); // re-chaining changed every later hash
  const l = new Ledger(path);
  const note = `archived ${staged.archived} tooling-churn event(s), kept ${staged.kept}; archive at ${staged.archivePath}; pre-compaction ledger kept at ${staged.backupPath} (sha256 ${staged.originalSha256.slice(0, 16)})`;
  l.append({
    actor: by,
    action: "ledger.compact",
    summary: note,
    source: "manual",
    payload: { archived: staged.archived, kept: staged.kept, archive: staged.archivePath, backup: staged.backupPath, originalSha256: staged.originalSha256 },
    rationale: { provenance: "declared", reason: "tooling churn was burying the record", approvedBy: by.name },
  });

  const v = Ledger.verify(path);
  return { ok: v.ok, archived: staged.archived, kept: staged.kept, archive: staged.archivePath, backup: staged.backupPath, originalSha256: staged.originalSha256, note };
}
