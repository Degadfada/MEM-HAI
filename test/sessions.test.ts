import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.ts";
import {
  confidenceOf,
  dayBounds,
  dayIndex,
  dayReport,
  eventsOn,
  humanDuration,
  localDay,
  sessionize,
} from "../src/sessions.ts";
import { tmpPath } from "./helpers.ts";

const at = (iso: string) => iso;

test("sessions split on an idle gap and measure the span of each", () => {
  const l = new Ledger(tmpPath());
  const ai = { kind: "ai" as const, name: "copilot" };
  // two bursts 40 minutes apart
  l.append({ actor: ai, action: "file.edit", target: "a.ts", ts: at("2026-10-14T09:00:00.000Z") });
  l.append({ actor: ai, action: "file.edit", target: "b.ts", ts: at("2026-10-14T09:05:00.000Z") });
  l.append({ actor: ai, action: "file.edit", target: "c.ts", ts: at("2026-10-14T09:45:00.000Z") });

  const s = sessionize(l.all());
  assert.equal(s.length, 2);
  assert.equal(s[0]!.events, 2);
  assert.equal(s[0]!.durationMs, 5 * 60_000);
  assert.deepEqual(s[0]!.files, ["a.ts", "b.ts"]);
  assert.equal(s[1]!.events, 1);
  assert.equal(s[1]!.observed, "single-event");
  assert.equal(s[1]!.durationMs, 0);
});

test("two AIs working in the same window get separate sessions", () => {
  const l = new Ledger(tmpPath());
  l.append({ actor: { kind: "ai", name: "copilot" }, action: "file.edit", target: "a.ts", ts: at("2026-10-14T09:00:00.000Z") });
  l.append({ actor: { kind: "ai", name: "claude-code" }, action: "file.edit", target: "b.ts", ts: at("2026-10-14T09:01:00.000Z") });
  l.append({ actor: { kind: "ai", name: "copilot" }, action: "file.edit", target: "c.ts", ts: at("2026-10-14T09:02:00.000Z") });

  const s = sessionize(l.all());
  assert.equal(s.length, 2);
  const names = s.map((x) => x.actor.name).sort();
  assert.deepEqual(names, ["claude-code", "copilot"]);
  assert.equal(s.find((x) => x.actor.name === "copilot")!.events, 2);
});

test("a custom idle gap merges or splits accordingly", () => {
  const l = new Ledger(tmpPath());
  const ai = { kind: "ai" as const, name: "gemini" };
  l.append({ actor: ai, action: "file.edit", target: "a.ts", ts: at("2026-10-14T09:00:00.000Z") });
  l.append({ actor: ai, action: "file.edit", target: "b.ts", ts: at("2026-10-14T09:20:00.000Z") });

  assert.equal(sessionize(l.all()).length, 2, "20 min apart splits at the 15 min default");
  assert.equal(sessionize(l.all(), { idleMs: 30 * 60_000 }).length, 1, "a 30 min gap merges them");
});

test("confidence: exact when named, inferred when deduced, unattributed when nobody claimed it", () => {
  const l = new Ledger(tmpPath());
  const a = l.append({ actor: { kind: "ai", name: "claude-code" }, action: "file.edit", target: "a.ts", source: "hook" });
  const b = l.append({ actor: { kind: "ai", name: "copilot" }, action: "file.edit", target: "b.ts", source: "vscode-watch", confidence: "inferred" });
  const c = l.append({ actor: { kind: "unknown", name: "unattributed" }, action: "file.edit", target: "c.ts", source: "vscode-watch" });

  assert.equal(a.confidence, "exact");
  assert.equal(b.confidence, "inferred");
  assert.equal(c.confidence, "unattributed");
  assert.equal(confidenceOf(a), "exact");
  assert.equal(confidenceOf(b), "inferred");
  assert.equal(confidenceOf(c), "unattributed");
});

test("confidence survives the hash chain and is classified for older events that lack it", () => {
  const path = tmpPath();
  const l = new Ledger(path);
  l.append({ actor: { kind: "ai", name: "copilot" }, action: "file.edit", target: "a.ts", confidence: "inferred" });
  assert.equal(Ledger.verify(path).ok, true, "a confidence field does not break verification");

  // an event shaped like one written before the field existed
  const legacy = { ...l.all()[0]!, confidence: undefined } as any;
  assert.equal(confidenceOf(legacy), "inferred", "an AI seen by the watcher, not a hook, reads as inferred");
  assert.equal(confidenceOf({ ...legacy, source: "hook" }), "exact");
  assert.equal(confidenceOf({ ...legacy, actor: { kind: "unknown", name: "unattributed" } }), "unattributed");
});

test("a day report says who worked, for how long, and on what", () => {
  const l = new Ledger(tmpPath());
  const day = localDay(new Date("2026-10-14T12:00:00.000Z"));
  const base = dayBounds(day).from.getTime();
  const t = (min: number) => new Date(base + min * 60_000).toISOString();

  l.append({ actor: { kind: "ai", name: "copilot" }, action: "file.edit", target: "src/a.ts", ts: t(600), confidence: "inferred" });
  l.append({ actor: { kind: "ai", name: "copilot" }, action: "file.edit", target: "src/b.ts", ts: t(610), confidence: "inferred" });
  l.append({ actor: { kind: "ai", name: "copilot" }, action: "command.run", target: "npm test", ts: t(612), confidence: "inferred" });
  l.append({ actor: { kind: "human", name: "idahosa" }, action: "decision", summary: "keep MySQL", ts: t(615) });

  const r = dayReport(l.all(), day);
  assert.equal(r.date, day);
  assert.equal(r.events, 4);
  assert.equal(r.sessions.length, 2, "one for the AI, one for the human");

  const cop = r.byAi.find((x) => x.name === "copilot")!;
  assert.equal(cop.durationMs, 12 * 60_000);
  assert.equal(cop.events, 3);
  assert.equal(cop.files, 2, "the command is not a file");
  assert.deepEqual(r.filesTouched, ["src/a.ts", "src/b.ts"]);
  assert.equal(r.confidence.inferred, 3);
  assert.equal(r.confidence.exact, 1);

  const s = r.sessions.find((x) => x.actor.name === "copilot")!;
  assert.deepEqual(s.commands, ["npm test"]);
  assert.equal(s.actions["file.edit"], 2);
});

test("days are local days, so late-evening work is not filed under tomorrow", () => {
  const l = new Ledger(tmpPath());
  // 23:30 local on the 14th, whatever this machine's offset is
  const late = new Date(dayBounds("2026-10-14").from.getTime() + 23.5 * 3600_000);
  l.append({ actor: { kind: "ai", name: "copilot" }, action: "file.edit", target: "a.ts", ts: late.toISOString() });

  assert.equal(localDay(late), "2026-10-14");
  assert.equal(eventsOn(l.all(), "2026-10-14").length, 1);
  assert.equal(eventsOn(l.all(), "2026-10-15").length, 0);
});

test("the day index lists every day that has history, newest first", () => {
  const l = new Ledger(tmpPath());
  const noon = (d: string) => new Date(dayBounds(d).from.getTime() + 12 * 3600_000).toISOString();
  l.append({ actor: { kind: "ai", name: "copilot" }, action: "file.edit", target: "a.ts", ts: noon("2026-10-12") });
  l.append({ actor: { kind: "ai", name: "claude-code" }, action: "file.edit", target: "b.ts", ts: noon("2026-10-14") });
  l.append({ actor: { kind: "human", name: "idahosa" }, aiInUse: "cursor", action: "decision", summary: "x", ts: noon("2026-10-14") });

  const idx = dayIndex(l.all());
  assert.deepEqual(idx.map((d) => d.date), ["2026-10-14", "2026-10-12"]);
  assert.equal(idx[0]!.events, 2);
  assert.deepEqual(idx[0]!.ais, ["claude-code", "cursor"], "the AI in use counts even when the human acted");
});

test("a reversed action is still visible in its session, and counted as undone", () => {
  const l = new Ledger(tmpPath());
  const e = l.append({ actor: { kind: "ai", name: "copilot" }, action: "file.edit", target: "a.ts" });
  l.reverse(e.id, { kind: "human", name: "idahosa" }, "wrong file");

  const s = sessionize(l.all(), { isReversed: (id) => l.isReversed(id) });
  const cop = s.find((x) => x.actor.name === "copilot")!;
  assert.equal(cop.events, 1);
  assert.equal(cop.reversed, 1, "history is not rewritten; the undo is reported");
});

test("durations read as English", () => {
  assert.equal(humanDuration(30_000), "under a minute");
  assert.equal(humanDuration(4 * 60_000), "4m");
  assert.equal(humanDuration(72 * 60_000), "1h 12m");
});

test("a bad date is refused rather than silently returning nothing", () => {
  assert.throws(() => dayBounds("14-10-2026"), /YYYY-MM-DD/);
  assert.throws(() => dayBounds("today"), /YYYY-MM-DD/);
});
