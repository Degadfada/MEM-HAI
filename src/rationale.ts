// Reading "why" out of a vendor transcript, for AIs that expose a hook.
//
// Claude Code hands its hooks a transcript_path, a prompt_id and a tool_use_id. That is enough to
// recover both halves of the handshake without the AI cooperating:
//
//   the ask    - only `user` records carry promptId, so the instruction is a direct lookup
//   the reason - assistant content blocks (thinking / text / tool_use) are separate records linked
//                by parentUuid, so walking back from the tool_use to the nearest `text` block gives
//                what the AI said it was doing. We take what it said out loud, not its thinking.
//
// Two constraints shape everything here. Transcripts reach tens of megabytes, and this runs on every
// single tool call -- so reads are tail-first and bounded, and the ask is cached per prompt. And it
// must never break a tool: anything unreadable yields "absent" rather than throwing.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provenance, Rationale } from "./types.ts";

/** Windows tried in order. Most answers are in the last few hundred KB. */
const WINDOWS = [512 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024];

export interface TranscriptRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  promptId?: string;
  sessionId?: string;
  message?: { role?: string; content?: unknown };
  [k: string]: unknown;
}

/** Read the last `bytes` of a file as whole lines. The first, probably-torn line is dropped. */
export function readTail(path: string, bytes: number): string[] {
  const size = statSync(path).size;
  const from = Math.max(0, size - bytes);
  const len = size - from;
  if (len <= 0) return [];
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, from);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (from > 0) lines.shift(); // cut mid-record
  return lines.filter((l) => l.length > 0);
}

const parse = (lines: string[]): TranscriptRecord[] => {
  const out: TranscriptRecord[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l) as TranscriptRecord);
    } catch { /* torn or non-JSON line: skip it, never throw */ }
  }
  return out;
};

/** Plain text of a record's message, whatever shape the content is in. */
function textOf(r: TranscriptRecord, kind: "text" | "any" = "text"): string {
  const c = r.message?.content;
  if (typeof c === "string") return c.trim();
  if (!Array.isArray(c)) return "";
  return c
    .filter((b: any) => (kind === "any" ? true : b?.type === "text"))
    .map((b: any) => b?.text ?? "")
    .join(" ")
    .trim();
}

/**
 * A real instruction from the person, not a tool result or an injected block.
 * Tool results and system-injected context arrive as `user` records too, and reading one of those
 * back as "what the human asked" would be worse than recording nothing.
 */
function isHumanTurn(r: TranscriptRecord): boolean {
  if (r.type !== "user") return false;
  const t = textOf(r, "any");
  if (!t) return false;
  if (t.startsWith("<")) return false; // <system-reminder>, <pasted_content>, tool payloads
  const c = r.message?.content;
  if (Array.isArray(c) && c.some((b: any) => b?.type === "tool_result")) return false;
  return true;
}

export interface ReadRationaleOpts {
  transcriptPath?: string;
  promptId?: string;
  toolUseId?: string;
  sessionId?: string;
  /** Where to cache the resolved ask. Omit to skip caching (tests). */
  cacheDir?: string;
  /** Injectable for tests. */
  readWindow?: (path: string, bytes: number) => string[];
}

interface Found {
  ask?: string;
  reason?: string;
}

/** Search one window for both halves. Returns what it found; the caller decides whether to widen. */
function searchWindow(records: TranscriptRecord[], promptId?: string, toolUseId?: string): Found {
  const out: Found = {};

  if (promptId) {
    for (const r of records) {
      if (r.promptId === promptId && isHumanTurn(r)) {
        out.ask = textOf(r, "any");
        break;
      }
    }
  }

  if (toolUseId) {
    const byUuid = new Map<string, TranscriptRecord>();
    for (const r of records) if (r.uuid) byUuid.set(r.uuid, r);

    // the record whose message contains this tool_use
    const origin = records.find((r) => {
      const c = r.message?.content;
      return Array.isArray(c) && c.some((b: any) => b?.type === "tool_use" && b?.id === toolUseId);
    });

    if (origin) {
      // If the AI spoke in the same message as the call, that is the reason.
      const inline = textOf(origin);
      if (inline) out.reason = inline;
      else {
        // Otherwise walk back up the chain to the nearest thing it said out loud.
        let cur: TranscriptRecord | undefined = origin;
        for (let hops = 0; cur?.parentUuid && hops < 80; hops++) {
          cur = byUuid.get(cur.parentUuid);
          if (!cur) break;
          if (cur.type === "assistant") {
            const t = textOf(cur);
            if (t) { out.reason = t; break; }
          }
          // Reaching the person's own turn means the AI acted without saying anything.
          if (isHumanTurn(cur)) break;
        }
      }
    }
  }

  return out;
}

const cacheFile = (dir: string, sessionId: string, promptId: string) =>
  join(dir, `ask-${sessionId}-${promptId}`.replace(/[^a-zA-Z0-9._-]/g, "_") + ".txt");

/**
 * Recover the rationale for one tool call. Never throws: an unreadable or missing transcript yields
 * `absent`, because this sits in the path of every tool call and must not be able to block work.
 */
export function readRationale(o: ReadRationaleOpts): Rationale {
  const absent: Rationale = { provenance: "absent" };
  const ref = {
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    ...(o.promptId ? { promptId: o.promptId } : {}),
    ...(o.toolUseId ? { toolUseId: o.toolUseId } : {}),
    ...(o.transcriptPath ? { transcript: o.transcriptPath } : {}),
  };

  try {
    // A burst of tool calls shares one prompt, so the ask is read once and reused.
    let cachedAsk: string | undefined;
    const canCache = o.cacheDir && o.sessionId && o.promptId;
    const cf = canCache ? cacheFile(o.cacheDir!, o.sessionId!, o.promptId!) : undefined;
    if (cf && existsSync(cf)) cachedAsk = readFileSync(cf, "utf8");

    const path = o.transcriptPath;
    if (!path || !existsSync(path)) return cachedAsk ? { provenance: "cited", ask: cachedAsk, ref } : absent;

    const read = o.readWindow ?? readTail;
    const size = statSync(path).size;
    let found: Found = {};

    for (const w of WINDOWS) {
      found = searchWindow(parse(read(path, w)), cachedAsk ? undefined : o.promptId, o.toolUseId);
      if (cachedAsk) found.ask = cachedAsk;
      // Stop as soon as we have both, or once the window already covered the whole file.
      if ((found.ask || !o.promptId) && (found.reason || !o.toolUseId)) break;
      if (w >= size) break;
    }

    if (cf && found.ask && !cachedAsk) {
      try {
        mkdirSync(o.cacheDir!, { recursive: true });
        writeFileSync(cf, found.ask);
      } catch { /* cache is an optimisation, never a requirement */ }
    }

    if (!found.ask && !found.reason) return absent;
    const provenance: Provenance = "cited";
    return { provenance, ...(found.ask ? { ask: found.ask } : {}), ...(found.reason ? { reason: found.reason } : {}), ref };
  } catch {
    return absent;
  }
}
