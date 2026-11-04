import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Ledger } from "./ledger.ts";
import { makeBrief, FILENAME, type Target } from "./handoff.ts";
import { buildVerifiedBrief } from "./verify.ts";
import { UI_HTML } from "./ui/page.ts";
import type { EventInput } from "./types.ts";
import { addGuardrail, liveGuardrails } from "./guardrails.ts";
import { acceptItem, audit, closeContract, liveContracts, openContract } from "./scope.ts";
import { Registry } from "./providers.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { approveDispatch, dispatch, queue, review, type StewardDeps } from "./steward.ts";
import { finishDispatch } from "./learn.ts";
import { Projects, ledgerPathFor } from "./projects.ts";
import { Sessions, checkPassword, cookieOf, hasPassword, makeThrottle } from "./auth.ts";
import { defaultHome } from "./guardrails.ts";
import { dayIndex, dayReport, eventsOn, sessionize } from "./sessions.ts";
import { findExchange } from "./exchange.ts";
import { ledgerPathFor as ledgerFor } from "./projects.ts";

export interface ServerOptions {
  ledgerPath: string;
  projectRoot: string; // where handoff files (CLAUDE.md etc.) get written
  port?: number; // 0 = random free port
  token?: string;
  home?: string; // machine-wide state: providers, knowledge, projects, password. Defaults to ~/.handoff
  allowHosts?: string[]; // public hostnames (e.g. your Cloudflare tunnel name) that may reach this server
  fetch?: typeof fetch; // injectable for tests
}

export interface RunningServer {
  server: Server;
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}

const TARGETS = ["claude-md", "agents-md", "system-prompt", "mcp-json"] as const;
const MAX_BODY = 256 * 1024;
/** What a logged-in REMOTE user may write. All of it tightens or queues; nothing loosens control or touches files. */
const REMOTE_WRITES = new Set(["/api/dispatch", "/api/guardrails", "/api/contracts", "/api/logout", "/api/why"]);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) { fail(new Error("body too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

function tokenOk(given: string | null | undefined, want: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Security model. The socket binds 127.0.0.1 only; a tunnel (cloudflared, tailscale serve) forwards to it.
 * - Local (loopback Host, no forwarding headers): bearer token, full powers.
 * - Remote (any other Host, or forwarding headers): refused unless a password is set AND the Host is in allowHosts.
 *   Logged-in remote users can read, queue tasks (which wait for LOCAL approval), add guardrails and open contracts.
 *   Everything that loosens control or touches files (undo, approve, wake/sleep AIs, switch, write events) is local-only.
 * - No CORS headers; cookie sessions are HttpOnly + SameSite=Strict and need an X-Handoff header on writes (CSRF).
 * - Logins are throttled; bodies are capped.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(24).toString("hex");
  new Ledger(opts.ledgerPath); // create the file up front if missing
  const root = resolve(opts.projectRoot);
  const home = opts.home ?? defaultHome();
  const allow = (opts.allowHosts ?? []).map((h) => h.toLowerCase());
  const sessions = new Sessions();
  const throttle = makeThrottle();
  let port = 0;

  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type + "; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      const host = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
      const loopback = host === "127.0.0.1" || host === "localhost";
      const fwd = !!(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"]);
      const remote = !loopback || fwd;
      if (!loopback && !allow.includes(host)) return send(403, { error: "bad host" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const ip = String(req.headers["cf-connecting-ip"] ?? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() ?? "") || req.socket.remoteAddress || "?";
      const secure = String(req.headers["x-forwarded-proto"] ?? "") === "https";

      if (remote && !hasPassword(home)) return send(403, { error: "remote access is off: set a password first (handoff auth set-password)" });

      if (req.method === "GET" && url.pathname === "/") return send(200, UI_HTML, "text/html");

      if (req.method === "POST" && url.pathname === "/login") {
        const t = throttle.check(ip);
        if (!t.ok) { res.setHeader("retry-after", String(t.retryAfterSec)); return send(429, { error: "too many attempts", retryAfterSec: t.retryAfterSec }); }
        const b = JSON.parse(await readBody(req)) as { password?: string };
        if (!hasPassword(home) || !checkPassword(home, String(b.password ?? ""))) { throttle.fail(ip); return send(401, { error: "wrong password" }); }
        throttle.clear(ip);
        const sid = sessions.create();
        res.setHeader("set-cookie", `hl_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessions.ttlSeconds}${secure ? "; Secure" : ""}`);
        return send(200, { ok: true });
      }
      if (!url.pathname.startsWith("/api/")) return send(404, { error: "not found" });

      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const sid = cookieOf(req.headers.cookie, "hl_session");
      const viaToken = tokenOk(bearer, token);
      const viaCookie = !viaToken && sessions.valid(sid);
      if (!viaToken && !viaCookie) return send(401, { error: "missing or bad credentials" });
      if (viaCookie && req.method !== "GET" && req.headers["x-handoff"] !== "1") return send(403, { error: "missing X-Handoff header" });
      if (req.method === "POST" && url.pathname === "/api/logout") { sessions.destroy(sid); res.setHeader("set-cookie", "hl_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"); return send(200, { ok: true }); }
      if (remote && req.method !== "GET" && !REMOTE_WRITES.has(url.pathname)) return send(403, { error: "this action is only allowed from this computer" });

      // The ledger file can be appended to by hooks in other processes: reload to see their events.
      let lp = opts.ledgerPath;
      const proj = url.searchParams.get("project");
      if (proj) lp = ledgerPathFor(new Projects(home).get(proj).root);
      const fresh = Ledger.open(lp); // shared handle: parse once, then only new bytes
      const registry = new Registry({ home, fetch: opts.fetch, onEvent: (e) => fresh.append({ actor: { kind: "system", name: "registry" }, action: e.action, summary: e.summary, payload: e.payload, rationale: e.rationale, source: "registry" }) });
      const steward = (): StewardDeps => ({
        ledger: fresh, home, knowledge: new KnowledgeStore(join(home, "knowledge")),
        ask: registry.holder("steward") ? async (system, prompt) => (await registry.askSteward({ system, prompt, maxTokens: 700 })).text : undefined,
      });

      if (req.method === "GET" && url.pathname === "/api/summary") {
        const ev = fresh.all();
        const by: Record<string, number> = {};
        const approvals: Record<string, number> = {};
        let ai = 0, human = 0;
        for (const e of ev) {
          by[e.action] = (by[e.action] ?? 0) + 1;
          approvals[e.approval.status] = (approvals[e.approval.status] ?? 0) + 1;
          if (e.actor.kind === "ai") ai++; else if (e.actor.kind === "human") human++;
        }
        const trail: string[] = [];
        for (const e of ev) if (e.delta === 1 && !fresh.isReversed(e.id) && e.aiInUse && trail[trail.length - 1] !== e.aiInUse) trail.push(e.aiInUse);
        return send(200, { events: ev.length, byAction: by, approvals, aiEvents: ai, humanEvents: human, aiTrail: trail, currentAi: trail[trail.length - 1] ?? null, verify: Ledger.verify(lp) });
      }
      // --- history: time travel. All read-only.
      if (req.method === "GET" && url.pathname === "/api/days") {
        const all = dayIndex(fresh.all()); // already newest-first
        const limit = Math.min(365, Math.max(1, Number(url.searchParams.get("limit") ?? 60)));
        const before = url.searchParams.get("before");
        const from = before ? all.findIndex((d) => d.date < before) : 0;
        const start = from < 0 ? all.length : from;
        const page = all.slice(start, start + limit);
        const next = all[start + limit]?.date ?? null;
        return send(200, { days: page, nextBefore: next, total: all.length });
      }
      if (req.method === "GET" && url.pathname === "/api/day") {
        const date = url.searchParams.get("date") ?? "";
        const idle = Number(url.searchParams.get("idle") ?? 0);
        try {
          return send(200, dayReport(fresh.all(), date, {
            idleMs: idle > 0 ? idle * 60_000 : undefined,
            isReversed: (id: string) => fresh.isReversed(id),
          }));
        } catch (e) {
          return send(400, { error: (e as Error).message });
        }
      }
      if (req.method === "GET" && url.pathname === "/api/day/events") {
        const date = url.searchParams.get("date") ?? "";
        try {
          return send(200, eventsOn(fresh.all(), date).map((e) => ({ ...e, reversed: fresh.isReversed(e.id) })));
        } catch (e) {
          return send(400, { error: (e as Error).message });
        }
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const idle = Number(url.searchParams.get("idle") ?? 0);
        return send(200, sessionize(fresh.all(), {
          idleMs: idle > 0 ? idle * 60_000 : undefined,
          isReversed: (id: string) => fresh.isReversed(id),
        }));
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        // Keyset pagination on seq, not offset: the ledger only ever grows, so an offset would
        // slide under the reader between pages. `before` walks backwards to seq 0.
        const all = fresh.all();
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
        const beforeRaw = url.searchParams.get("before");
        const before = beforeRaw === null || beforeRaw === "" ? Infinity : Number(beforeRaw);
        if (!Number.isFinite(before) && before !== Infinity) return send(400, { error: "before must be a number" });

        const who = url.searchParams.get("actor");
        const act = url.searchParams.get("action");
        const prov = url.searchParams.get("provenance");

        const page: any[] = [];
        let nextBefore: number | null = null;
        for (let i = all.length - 1; i >= 0; i--) {
          const e = all[i]!;
          if (e.seq >= before) continue;
          if (who && e.actor.name !== who) continue;
          if (act && e.action !== act) continue;
          if (prov && (e.rationale?.provenance ?? "absent") !== prov) continue;
          if (page.length === limit) { nextBefore = e.seq + 1; break; }
          page.push({ ...e, reversed: fresh.isReversed(e.id) });
        }
        return send(200, { events: page, nextBefore, total: all.length, oldestSeq: all.length ? all[0]!.seq : null });
      }
      if (req.method === "GET" && url.pathname === "/api/event") {
        const id = url.searchParams.get("id") ?? "";
        const e = fresh.get(id);
        if (!e) return send(404, { error: "no such event" });
        // Resolve the citation so the untruncated original is one click away.
        const hash = e.rationale?.ref?.exchangeSha256;
        const exchange = hash ? findExchange(home, hash) : undefined;
        return send(200, { ...e, reversed: fresh.isReversed(e.id), exchange: exchange ?? null });
      }
      if (req.method === "GET" && url.pathname === "/api/why") {
        // The backlog: actions with nothing on record explaining them.
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
        const beforeRaw = url.searchParams.get("before");
        const before = beforeRaw === null || beforeRaw === "" ? Infinity : Number(beforeRaw);
        const all = fresh.all();
        const page: any[] = [];
        let nextBefore: number | null = null;
        let unexplained = 0;
        for (let i = all.length - 1; i >= 0; i--) {
          const e = all[i]!;
          const bare = !e.rationale || e.rationale.provenance === "absent";
          if (!bare) continue;
          unexplained++;
          if (e.seq >= before) continue;
          if (page.length >= limit) { if (nextBefore === null) nextBefore = e.seq + 1; continue; }
          page.push({ ...e, reversed: fresh.isReversed(e.id) });
        }
        return send(200, { events: page, nextBefore, unexplained, total: all.length });
      }
      if (req.method === "POST" && url.pathname === "/api/why") {
        // Annotating an unexplained action. It is a new event citing the old one: the log is
        // append-only, so a reason added later is itself part of the record.
        const b = JSON.parse(await readBody(req));
        if (!b?.id || !b?.reason) return send(400, { error: "id and reason required" });
        const target = fresh.get(String(b.id));
        if (!target) return send(404, { error: "no such event" });
        const ev = fresh.append({
          actor: { kind: "human", name: String(b.by ?? "human") },
          action: "reason.added", target: target.id,
          summary: String(b.reason), source: "manual",
          rationale: { provenance: "declared", reason: String(b.reason), approvedBy: String(b.by ?? "human") },
        });
        return send(200, { ok: true, id: ev.id });
      }
      if (req.method === "POST" && url.pathname === "/api/events") {
        const input = JSON.parse(await readBody(req)) as EventInput;
        if (!input?.actor?.kind || !input?.actor?.name || !input?.action) return send(400, { error: "actor.kind, actor.name, action required" });
        return send(200, fresh.append(input));
      }
      if (req.method === "POST" && url.pathname === "/api/reverse") {
        const b = JSON.parse(await readBody(req)) as { id: string; by?: string; summary?: string };
        return send(200, fresh.reverse(b.id, { kind: "human", name: b.by ?? "human" }, b.summary));
      }
      if (req.method === "POST" && url.pathname === "/api/switch") {
        const b = JSON.parse(await readBody(req)) as { to: string; by?: string; target?: Target; write?: boolean; verify?: boolean };
        if (!b.to) return send(400, { error: "to required" });
        const target: Target = (TARGETS as readonly string[]).includes(b.target ?? "") ? b.target! : "claude-md";
        const sw = fresh.append({ actor: { kind: "human", name: b.by ?? "human" }, action: "ai.switch", aiInUse: b.to, summary: `switched to ${b.to}`, source: "ui" });
        const tuned = b.verify === false ? null : await buildVerifiedBrief(fresh, b.to, target);
        const brief = tuned ? tuned.brief : makeBrief(fresh, b.to, target);
        let wrote: string | null = null;
        if (b.write) {
          wrote = join(root, FILENAME[target]);
          mkdirSync(dirname(wrote), { recursive: true });
          writeFileSync(wrote, brief.text);
        }
        return send(200, { switchEvent: sw.id, target, text: brief.text, metrics: brief.metrics, verification: tuned ? tuned.report : null, wrote });
      }
      if (req.method === "GET" && url.pathname === "/api/guardrails") return send(200, liveGuardrails(fresh));
      if (req.method === "POST" && url.pathname === "/api/guardrails") {
        const b = JSON.parse(await readBody(req)) as { level?: "block" | "advise"; text: string; match: { kind: "command" | "path" | "action"; pattern: string }; by?: string };
        return send(200, addGuardrail(fresh, { kind: "human", name: b.by ?? "human" }, b.level === "advise" ? "advise" : "block", b.text ?? "", b.match, "ui"));
      }
      if (req.method === "GET" && url.pathname === "/api/contracts") return send(200, liveContracts(fresh).map((c) => ({ ...c, audit: audit(fresh, c.id) })));
      if (req.method === "POST" && url.pathname === "/api/contracts") {
        const b = JSON.parse(await readBody(req)) as { id: string; goal: string; acceptance?: string[]; inScope?: string[]; outOfScope?: string[]; by?: string };
        return send(200, openContract(fresh, { kind: "human", name: b.by ?? "human" }, b));
      }
      if (req.method === "POST" && url.pathname === "/api/contracts/accept") {
        const b = JSON.parse(await readBody(req)) as { id: string; item: number; by?: string };
        return send(200, acceptItem(fresh, { kind: "human", name: b.by ?? "human" }, b.id, Number(b.item)));
      }
      if (req.method === "POST" && url.pathname === "/api/contracts/close") {
        const b = JSON.parse(await readBody(req)) as { id: string; by?: string };
        return send(200, closeContract(fresh, { kind: "human", name: b.by ?? "human" }, b.id));
      }
      if (req.method === "GET" && url.pathname === "/api/providers") return send(200, registry.status());
      if (req.method === "POST" && url.pathname === "/api/providers/wake") {
        const b = JSON.parse(await readBody(req)) as { name: string; role: "editor" | "steward" };
        if (b.role !== "editor" && b.role !== "steward") return send(400, { error: "role must be editor or steward" });
        return send(200, registry.wake(b.name, b.role));
      }
      if (req.method === "POST" && url.pathname === "/api/providers/sleep") return send(200, registry.sleep((JSON.parse(await readBody(req)) as { name: string }).name) ?? { ok: true });
      if (req.method === "GET" && url.pathname === "/api/queue") return send(200, queue(fresh));
      if (req.method === "POST" && url.pathname === "/api/dispatch") {
        const b = JSON.parse(await readBody(req)) as { task: string; contract?: string; by?: string };
        const r = await dispatch(steward(), { kind: "human", name: b.by ?? (remote ? "remote" : "human") }, b.task ?? "", { contract: b.contract, source: remote ? "remote" : "local" });
        return send(200, { id: r.id, status: r.status, prompt: r.compiled.prompt, arm: r.compiled.arm, via: r.compiled.via, why: r.compiled.why, tokens: r.compiled.tokens, sourceTokens: r.compiled.sourceTokens });
      }
      if (req.method === "POST" && url.pathname === "/api/queue/approve") return send(200, approveDispatch(fresh, { kind: "human", name: "human" }, (JSON.parse(await readBody(req)) as { id: string }).id));
      if (req.method === "POST" && url.pathname === "/api/queue/finish") return send(200, finishDispatch(fresh, { kind: "human", name: "human" }, (JSON.parse(await readBody(req)) as { id: string }).id));
      if (req.method === "GET" && url.pathname === "/api/review") { const r = review(steward()); return send(200, { text: r.text, suggestions: r.suggestions, audits: r.audits.map((a) => ({ id: a.contract.id, verdict: a.verdict })) }); }
      if (req.method === "GET" && url.pathname === "/api/projects") {
        const P = new Projects(home);
        // Enough per project to choose one at a glance: how much is recorded, when it was last
        // touched, which AIs have worked on it, whether its chain is intact, and -- the health
        // metric for this whole system -- what share of its actions can say why they happened.
        const rows = P.list.map((pr) => {
          const lp = ledgerFor(pr.root);
          const base = { name: pr.name, root: pr.root, events: 0, lastActivity: null as string | null, days: 0, ais: [] as string[], chain: "missing" as string, explained: 0, unexplained: 0, coverage: 0, openContracts: 0 };
          try {
            const pl = new Ledger(lp);
            const ev = pl.all();
            const ais = new Set<string>();
            let explained = 0;
            for (const e of ev) {
              if (e.actor.kind === "ai") ais.add(e.actor.name);
              else if (e.aiInUse) ais.add(e.aiInUse);
              if (e.rationale && e.rationale.provenance !== "absent") explained++;
            }
            const v = Ledger.verify(lp);
            return {
              ...base,
              events: ev.length,
              lastActivity: ev.length ? ev[ev.length - 1]!.ts : null,
              days: dayIndex(ev).length,
              ais: [...ais].sort(),
              chain: v.ok ? "intact" : `broken: ${v.error ?? "unknown"}`,
              explained,
              unexplained: ev.length - explained,
              coverage: ev.length ? Math.round((explained / ev.length) * 100) : 0,
              openContracts: liveContracts(pl).length,
            };
          } catch (e) {
            return { ...base, chain: `unreadable: ${(e as Error).message}` };
          }
        });
        return send(200, rows);
      }
      if (req.method === "GET" && url.pathname === "/api/lessons") return send(200, new Projects(home).lessons());
      if (req.method === "POST" && url.pathname === "/api/consolidate") return send(200, new Projects(home).consolidate());
      if (req.method === "GET" && url.pathname === "/api/knowledge/search") return send(200, new KnowledgeStore(join(home, "knowledge")).search(url.searchParams.get("q") ?? "", 5));
      if (req.method === "GET" && url.pathname === "/api/brief") {
        const target = (url.searchParams.get("target") ?? "claude-md") as Target;
        if (!(TARGETS as readonly string[]).includes(target)) return send(400, { error: "bad target" });
        const to = url.searchParams.get("to") ?? "the next AI";
        const budget = url.searchParams.get("budget");
        const b = makeBrief(fresh, to, target, budget ? Number(budget) : undefined);
        return send(200, { text: b.text, metrics: b.metrics });
      }
      return send(404, { error: "not found" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return send(err instanceof SyntaxError || /required|must|already|no such|no open|no contract|contract id|invalid|not a dispatch|asleep|provider|budget|password|role|ReDoS|not a valid|cannot/.test(msg) ? 400 : 500, { error: msg });
    }
  });

  await new Promise<void>((ok) => server.listen(opts.port ?? 0, "127.0.0.1", ok));
  port = (server.address() as { port: number }).port;
  return {
    server, port, token,
    url: `http://127.0.0.1:${port}/#token=${token}`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
