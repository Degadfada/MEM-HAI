// Work sessions and time travel.
//
// Both are DERIVED from the ledger on read, never stored. The events of one actor are clustered
// by idle gap, so "which AI worked on the 14th, for how long, and on what" is answerable for
// history that was recorded long before this module existed. Nothing here writes.
//
// Days are LOCAL days. The ledger stores UTC instants; a person asking what happened on the 14th
// means their own 14th, so grouping by UTC date would file evening work under tomorrow.

import type { Confidence, LedgerEvent } from "./types.ts";

/** A gap longer than this between two events of one actor starts a new session. */
export const DEFAULT_IDLE_MS = 15 * 60_000;

/** How much we actually know about who did it. Events written before this field existed land here. */
export function confidenceOf(e: LedgerEvent): Confidence {
  if (e.confidence) return e.confidence;
  if (e.actor.kind === "unknown") return "unattributed";
  // A hook, an MCP client and a deliberate human entry all name their own author.
  if (e.source === "hook" || e.source === "mcp" || e.source === "manual" || e.source === "local") return "exact";
  return "inferred";
}

/** Identity a session belongs to. The AI in use separates two AIs driven by the same person. */
export const actorKey = (e: LedgerEvent): string =>
  `${e.actor.kind}:${e.actor.name}${e.actor.kind === "human" && e.aiInUse ? ` via ${e.aiInUse}` : ""}`;

export interface Session {
  key: string;
  actor: { kind: string; name: string };
  aiInUse?: string;
  start: string;
  end: string;
  /** Span from first to last recorded action. NOT wall-clock presence: an actor idle inside the
   *  gap threshold still counts, and a session of one event spans zero. See `observed`. */
  durationMs: number;
  observed: "span" | "single-event";
  events: number;
  actions: Record<string, number>;
  files: string[];
  commands: string[];
  confidence: Record<Confidence, number>;
  approvals: Record<string, number>;
  reversed: number;
  firstId: string;
  lastId: string;
}

const FILE_ACTION = /^file\./;

function summarize(group: LedgerEvent[], isReversed: (id: string) => boolean): Session {
  const first = group[0]!, last = group[group.length - 1]!;
  const actions: Record<string, number> = {};
  const confidence: Record<Confidence, number> = { exact: 0, inferred: 0, unattributed: 0 };
  const approvals: Record<string, number> = {};
  const files = new Set<string>(), commands = new Set<string>();
  let reversed = 0;

  for (const e of group) {
    actions[e.action] = (actions[e.action] ?? 0) + 1;
    confidence[confidenceOf(e)]++;
    approvals[e.approval.status] = (approvals[e.approval.status] ?? 0) + 1;
    if (e.target && FILE_ACTION.test(e.action)) files.add(e.target);
    if (e.target && e.action === "command.run") commands.add(e.target);
    if (isReversed(e.id)) reversed++;
  }

  return {
    key: actorKey(first),
    actor: { kind: first.actor.kind, name: first.actor.name },
    aiInUse: first.aiInUse,
    start: first.ts,
    end: last.ts,
    durationMs: Date.parse(last.ts) - Date.parse(first.ts),
    observed: group.length === 1 ? "single-event" : "span",
    events: group.length,
    actions,
    files: [...files].sort(),
    commands: [...commands],
    confidence,
    approvals,
    reversed,
    firstId: first.id,
    lastId: last.id,
  };
}

export interface SessionOpts {
  idleMs?: number;
  isReversed?: (id: string) => boolean;
}

/** Cluster events into per-actor sessions, in start order. */
export function sessionize(events: readonly LedgerEvent[], o: SessionOpts = {}): Session[] {
  const idle = o.idleMs ?? DEFAULT_IDLE_MS;
  const isReversed = o.isReversed ?? (() => false);
  const open = new Map<string, LedgerEvent[]>();
  const done: LedgerEvent[][] = [];

  // Append order is time order for anything the tool wrote itself; sort anyway for imports.
  const sorted = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.seq - b.seq);
  for (const e of sorted) {
    if (e.type !== "event") continue;
    const k = actorKey(e);
    const cur = open.get(k);
    if (cur && Date.parse(e.ts) - Date.parse(cur[cur.length - 1]!.ts) <= idle) cur.push(e);
    else {
      if (cur) done.push(cur);
      open.set(k, [e]);
    }
  }
  for (const g of open.values()) done.push(g);
  return done
    .map((g) => summarize(g, isReversed))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** YYYY-MM-DD in the timezone of this machine. */
export function localDay(ts: string | Date): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local midnight-to-midnight bounds of a YYYY-MM-DD, as instants. */
export function dayBounds(date: string): { from: Date; to: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`date must be YYYY-MM-DD, got ${date}`);
  const from = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  const to = new Date(from.getTime());
  to.setDate(to.getDate() + 1);
  return { from, to };
}

export function eventsOn(events: readonly LedgerEvent[], date: string): LedgerEvent[] {
  const { from, to } = dayBounds(date);
  return events.filter((e) => {
    const t = Date.parse(e.ts);
    return t >= from.getTime() && t < to.getTime();
  });
}

export function eventsBetween(events: readonly LedgerEvent[], fromDate: string, toDate: string): LedgerEvent[] {
  const from = dayBounds(fromDate).from.getTime();
  const to = dayBounds(toDate).to.getTime();
  return events.filter((e) => {
    const t = Date.parse(e.ts);
    return t >= from && t < to;
  });
}

export interface DayIndexEntry {
  date: string;
  events: number;
  actors: string[];
  ais: string[];
}

/** Every day that has history, newest first. This is the calendar you page through. */
export function dayIndex(events: readonly LedgerEvent[]): DayIndexEntry[] {
  const byDay = new Map<string, { events: number; actors: Set<string>; ais: Set<string> }>();
  for (const e of events) {
    if (e.type !== "event") continue;
    const d = localDay(e.ts);
    const row = byDay.get(d) ?? { events: 0, actors: new Set<string>(), ais: new Set<string>() };
    row.events++;
    row.actors.add(`${e.actor.kind}:${e.actor.name}`);
    if (e.actor.kind === "ai") row.ais.add(e.actor.name);
    else if (e.aiInUse) row.ais.add(e.aiInUse);
    byDay.set(d, row);
  }
  return [...byDay.entries()]
    .map(([date, r]) => ({ date, events: r.events, actors: [...r.actors].sort(), ais: [...r.ais].sort() }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export interface DayReport {
  date: string;
  events: number;
  sessions: Session[];
  byAi: { name: string; kind: string; sessions: number; durationMs: number; events: number; files: number }[];
  filesTouched: string[];
  confidence: Record<Confidence, number>;
  reversed: number;
}

/** Everything that happened on one local day: who, how long, and what they touched. */
export function dayReport(events: readonly LedgerEvent[], date: string, o: SessionOpts = {}): DayReport {
  const day = eventsOn(events, date);
  const sessions = sessionize(day, o);

  const agg = new Map<string, { kind: string; sessions: number; durationMs: number; events: number; files: Set<string> }>();
  const confidence: Record<Confidence, number> = { exact: 0, inferred: 0, unattributed: 0 };
  const files = new Set<string>();
  let reversed = 0;

  for (const s of sessions) {
    const name = s.actor.kind === "ai" ? s.actor.name : s.aiInUse ?? s.actor.name;
    const row = agg.get(name) ?? { kind: s.actor.kind, sessions: 0, durationMs: 0, events: 0, files: new Set<string>() };
    row.sessions++;
    row.durationMs += s.durationMs;
    row.events += s.events;
    for (const f of s.files) { row.files.add(f); files.add(f); }
    agg.set(name, row);
    for (const k of ["exact", "inferred", "unattributed"] as Confidence[]) confidence[k] += s.confidence[k];
    reversed += s.reversed;
  }

  return {
    date,
    events: day.length,
    sessions,
    byAi: [...agg.entries()]
      .map(([name, r]) => ({ name, kind: r.kind, sessions: r.sessions, durationMs: r.durationMs, events: r.events, files: r.files.size }))
      .sort((a, b) => b.durationMs - a.durationMs || b.events - a.events),
    filesTouched: [...files].sort(),
    confidence,
    reversed,
  };
}

/** "1h 12m", "4m", "under a minute" -- for people, not machines. */
export function humanDuration(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
