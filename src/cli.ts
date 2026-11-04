import { Ledger } from "./ledger.ts";
import { FILENAME, makeBrief, type Target } from "./handoff.ts";
import { buildVerifiedBrief } from "./verify.ts";
import { startServer } from "./server.ts";
import { serveStdio } from "./mcp.ts";
import { KINDS, Registry, type Kind } from "./providers.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { Projects } from "./projects.ts";
import { approveDispatch, dispatch, queue, review, summarizeProject, type StewardDeps } from "./steward.ts";
import { finishDispatch } from "./learn.ts";
import { setPassword } from "./auth.ts";
import { addGlobalGuardrail, defaultHome } from "./guardrails.ts";
import { readFileSync } from "node:fs";
import { addGuardrail, liveGuardrails, evaluate } from "./guardrails.ts";
import { openContract, acceptItem, closeContract, audit, liveContracts } from "./scope.ts";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApprovalStatus } from "./types.ts";
import { confidenceOf, dayIndex, dayReport, humanDuration, localDay, sessionize } from "./sessions.ts";

const [cmd, ...rest] = process.argv.slice(2);

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--") && a.includes("=")) out[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (a.startsWith("--")) { const nxt = args[i + 1]; out[a.slice(2)] = nxt === undefined || nxt.startsWith("--") ? "" : args[++i]!; }
  }
  return out;
}

const f = flags(rest);
const file = f.file ?? process.env.LEDGER_FILE ?? ".handoff/ledger.jsonl";
const home = f.home ?? defaultHome();
const me = { kind: "human" as const, name: process.env.USER ?? "human" };
// Given a ledger, every API call this process makes lands in it -- with the exchange recorded and
// a "recorded" rationale attached. Without one, calls would run and leave no trace.
const registry = (l?: Ledger) =>
  new Registry({
    home,
    onEvent: l
      ? (e) => l.append({ actor: { kind: "system", name: "registry" }, action: e.action, summary: e.summary, payload: e.payload, rationale: e.rationale, source: "registry" })
      : undefined,
  });
const steward = (l: Ledger): StewardDeps => { const r = registry(l); return { ledger: l, home, knowledge: new KnowledgeStore(`${home}/knowledge`), ask: r.holder("steward") ? async (system, prompt) => (await r.askSteward({ system, prompt, maxTokens: 700 })).text : undefined }; };

function usage(): never {
  console.error(`usage:
  append  --actor-kind human|ai|system --actor NAME --action ACTION [--target T] [--summary S]
          [--ai AI_IN_USE] [--approval approved|denied|pending|not_required|unknown] [--approved-by NAME]
          [--source hook|git|vscode|manual] [--file PATH]
  reverse --id EVENT_ID --actor-kind ... --actor NAME [--summary S]
  brief   --to AI [--target claude-md|agents-md|system-prompt|mcp-json] [--out PATH|-] [--no-verify]
  serve   [--port N]   (dashboard on 127.0.0.1, prints the URL with its token)
  mcp     [--agent NAME]   (MCP server on stdio for any MCP-capable AI)
  guardrail add --level block|advise --text T --kind command|path|action --pattern P | list | check --action A [--target T]
  contract  open --id ID --goal G [--accept "a;b"] [--in "src/**;test/**"] [--out "x/**"] | list | accept --id ID --item N | close --id ID | audit --id ID
  providers add --name N --kind anthropic|gemini|ollama|openai-compatible --model M [--key-env ENVVAR] [--base-url U] | list | wake --name N --role editor|steward | sleep --name N | budget --tokens N
  knowledge ingest --path BOOK.txt | search --q "words"
  dispatch --task "what to do" [--contract ID] | queue | approve --id ID | finish --id ID | review | summary --name PROJECT
  projects add --name N --root DIR | list | summaries | consolidate | lessons
  auth set-password   (reads the password from HANDOFF_PASSWORD or stdin)
  guardrail add --global ...   (applies to every project)
  serve   [--port N] [--allow-host tunnel.example.com] [--home DIR]
  days    [--json]                 (every day that has history, newest first)
  day     [--date YYYY-MM-DD] [--idle MINUTES] [--json]   (who worked that day, for how long, on what)
  sessions [--date YYYY-MM-DD] [--idle MINUTES] [--json]
  list    [--file PATH]
  verify  [--file PATH]\n  repair  [--file PATH] --yes      (re-chain a ledger forked by concurrent writers; keeps the original)`);
  process.exit(2);
}

switch (cmd) {
  case "append": {
    if (!f["actor-kind"] || !f.actor || !f.action) usage();
    const l = new Ledger(file);
    const status = (f.approval ?? "unknown") as ApprovalStatus;
    const e = l.append({
      actor: { kind: f["actor-kind"] as "human" | "ai" | "system", name: f.actor },
      action: f.action,
      target: f.target,
      summary: f.summary,
      aiInUse: f.ai,
      source: f.source ?? "manual",
      approval: { status, by: f["approved-by"], at: f["approved-by"] ? new Date().toISOString() : undefined },
    });
    console.log(`${e.id}${e.redactions ? `  (redacted ${e.redactions.count}: ${e.redactions.kinds.join(",")})` : ""}`);
    break;
  }
  case "reverse": {
    if (!f.id || !f["actor-kind"] || !f.actor) usage();
    const l = new Ledger(file);
    const e = l.reverse(f.id, { kind: f["actor-kind"] as "human" | "ai" | "system", name: f.actor }, f.summary);
    console.log(e.id);
    break;
  }
  case "list": {
    const l = new Ledger(file);
    for (const e of l.all()) {
      const who = `${e.actor.kind}:${e.actor.name}`;
      const ai = e.aiInUse ? ` [ai=${e.aiInUse}]` : "";
      const ap = e.approval.status !== "unknown" ? ` approval=${e.approval.status}` : "";
      const rv = e.delta === -1 ? ` (undoes ${e.reverses})` : l.isReversed(e.id) ? " (reversed)" : "";
      const cf = confidenceOf(e) === "exact" ? "" : ` (${confidenceOf(e)})`;
      console.log(`${String(e.seq).padStart(4)}  ${e.id}  ${e.ts}  ${who}${ai}${cf}  ${e.action}${e.target ? " " + e.target : ""}${ap}${rv}`);
    }
    break;
  }
  case "days": {
    const l = new Ledger(file);
    const idx = dayIndex(l.all());
    if (!idx.length) { console.log("no history yet"); break; }
    if (f.json) { console.log(JSON.stringify(idx, null, 2)); break; }
    console.log("date         events  who worked");
    for (const d of idx)
      console.log(`${d.date}   ${String(d.events).padStart(5)}  ${(d.ais.length ? d.ais : d.actors).join(", ")}`);
    break;
  }
  case "day": {
    const l = new Ledger(file);
    const date = f.date || f.on || localDay(new Date());
    const idle = f.idle ? Number(f.idle) * 60_000 : undefined;
    const r = dayReport(l.all(), date, { idleMs: idle, isReversed: (id) => l.isReversed(id) });
    if (f.json) { console.log(JSON.stringify(r, null, 2)); break; }

    console.log(`== ${r.date} ==  ${r.events} event(s), ${r.sessions.length} session(s)`);
    if (!r.events) { console.log("nothing recorded on that day."); break; }

    console.log("");
    console.log("Who worked:");
    for (const a of r.byAi)
      console.log(`  ${a.name.padEnd(16)} ${humanDuration(a.durationMs).padEnd(14)} ${a.sessions} session(s), ${a.events} action(s), ${a.files} file(s)`);

    console.log("");
    console.log("Sessions:");
    for (const s of r.sessions) {
      const t = (x: string) => new Date(x).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const acts = Object.entries(s.actions).map(([k, n]) => `${k} x${n}`).join(", ");
      console.log(`  ${t(s.start)}-${t(s.end)}  ${humanDuration(s.durationMs).padEnd(14)} ${s.key}`);
      console.log(`      ${acts}`);
      if (s.files.length) console.log(`      files: ${s.files.slice(0, 8).join(", ")}${s.files.length > 8 ? ` (+${s.files.length - 8} more)` : ""}`);
      if (s.commands.length) console.log(`      commands: ${s.commands.slice(0, 4).map((c) => c.slice(0, 60)).join(" | ")}`);
      if (s.reversed) console.log(`      ${s.reversed} of these were later undone`);
    }

    const c = r.confidence;
    console.log("");
    console.log(`Attribution: ${c.exact} exact, ${c.inferred} inferred, ${c.unattributed} unattributed.`);
    if (c.unattributed) console.log("  (unattributed = the file changed and no AI was declared in use; not guessed)");
    if (r.filesTouched.length) console.log(`Files touched: ${r.filesTouched.length}`);
    break;
  }
  case "sessions": {
    const l = new Ledger(file);
    const idle = f.idle ? Number(f.idle) * 60_000 : undefined;
    const o = { idleMs: idle, isReversed: (id: string) => l.isReversed(id) };
    const src = f.date ? dayReport(l.all(), f.date, o).sessions : sessionize(l.all(), o);
    if (f.json) { console.log(JSON.stringify(src, null, 2)); break; }
    for (const s of src)
      console.log(`${s.start}  ${humanDuration(s.durationMs).padEnd(14)} ${s.key.padEnd(28)} ${s.events} action(s)${s.files.length ? `, ${s.files.length} file(s)` : ""}`);
    break;
  }
  case "repair": {
    const before = Ledger.verify(file);
    if (before.ok) { console.log(`nothing to repair: ${before.events} events, chain intact`); break; }
    console.log(`chain is broken: ${before.error}${before.atLine ? ` at line ${before.atLine}` : ""}`);
    if (!("yes" in f)) {
      console.log("");
      console.log("Repair re-links the chain. Every hash after the first break changes, so the original");
      console.log("signatures cannot be kept. No event is lost, the original file is saved beside this one,");
      console.log("and the repair is recorded as an event. Re-run with --yes to go ahead.");
      process.exit(2);
    }
    const r = Ledger.repair(file, me);
    console.log(r.note);
    console.log(r.ok ? "chain is intact again" : "STILL BROKEN after repair; keep the backup and investigate");
    if (!r.ok) process.exit(1);
    break;
  }
  case "verify": {
    const r = Ledger.verify(file);
    if (r.ok) console.log(`OK: ${r.events} events, chain intact`);
    else {
      console.error(`FAILED at line ${r.atLine}: ${r.error}`);
      process.exit(1);
    }
    break;
  }
  case "brief": {
    if (!f.to) usage();
    const target = (f.target ?? "claude-md") as Target;
    const l = new Ledger(file);
    const r = "no-verify" in f ? { brief: makeBrief(l, f.to, target), report: null } : await buildVerifiedBrief(l, f.to, target);
    if (f.out === "-") process.stdout.write(r.brief.text);
    else {
      const out = f.out ?? `${dirname(file).replace(/\.handoff$/, "") || "."}/${FILENAME[target]}`;
      writeFileSync(out, r.brief.text);
      const m = r.brief.metrics;
      console.error(`wrote ${out}: ${m.briefTokens} tokens from ${m.rawTokens} (${m.compressionRatio.toFixed(1)}x), hard rules ${m.hardKept}/${m.hardTotal}${r.report ? ", " + (r.report.pass ? "verified" : "NOT verified") : ""}`);
      if (r.report) console.error(r.report.statement);
    }
    break;
  }
  case "serve": {
    const srv = await startServer({ ledgerPath: file, projectRoot: process.cwd(), port: f.port ? Number(f.port) : 0, home, allowHosts: f["allow-host"] ? f["allow-host"].split(",") : [] });
    console.log(`Dashboard: ${srv.url}\n(Ctrl+C to stop. Bound to 127.0.0.1 only.)`);
    break;
  }
  case "mcp": {
    serveStdio({ ledgerPath: file, agentName: f.agent ?? "mcp-client", home });
    break;
  }
  case "guardrail": {
    const sf = flags(rest.slice(1));
    const l = new Ledger(file);
    const me = { kind: "human" as const, name: process.env.USER ?? "human" };
    if (rest[0] === "add" && "global" in sf) console.log(addGlobalGuardrail(home, (sf.level ?? "block") as "block", sf.text ?? "", { kind: sf.kind as "command", pattern: sf.pattern ?? "" }).id);
    else if (rest[0] === "add") { console.log(addGuardrail(l, me, (sf.level ?? "block") as "block", sf.text ?? "", { kind: sf.kind as "command", pattern: sf.pattern ?? "" }).id); }
    else if (rest[0] === "list") for (const g of liveGuardrails(l)) console.log(`${g.id}  ${g.level.padEnd(6)} ${g.match.kind}:${g.match.pattern}  ${g.text}`);
    else if (rest[0] === "check") { const v = evaluate(liveGuardrails(l), { action: sf.action ?? "", target: sf.target }); console.log(JSON.stringify({ allowed: v.allowed, rules: v.violations.map((x) => x.text) })); process.exit(v.allowed ? 0 : 3); }
    else usage();
    break;
  }
  case "contract": {
    const sf = flags(rest.slice(1));
    const l = new Ledger(file);
    const me = { kind: "human" as const, name: process.env.USER ?? "human" };
    const split = (s?: string) => (s ? s.split(";").map((x) => x.trim()).filter(Boolean) : []);
    if (rest[0] === "open") console.log(openContract(l, me, { id: sf.id ?? "", goal: sf.goal ?? "", acceptance: split(sf.accept), inScope: split(sf.in), outOfScope: split(sf.out) }).id);
    else if (rest[0] === "list") for (const c of liveContracts(l)) console.log(`${c.id}  ${c.goal}  (${c.acceptance.length} acceptance, scope: ${c.inScope.join(",") || "any"})`);
    else if (rest[0] === "accept") acceptItem(l, me, sf.id ?? "", Number(sf.item)), console.log("recorded");
    else if (rest[0] === "close") closeContract(l, me, sf.id ?? ""), console.log("closed");
    else if (rest[0] === "audit") console.log(audit(l, sf.id ?? "").text);
    else usage();
    break;
  }
  case "providers": {
    const sf = flags(rest.slice(1)), r = registry(new Ledger(file));
    if (rest[0] === "add") { r.add({ name: sf.name ?? "", kind: sf.kind as Kind, model: sf.model ?? "", keyEnv: sf["key-env"], baseUrl: sf["base-url"] }); console.log("added (asleep)"); }
    else if (rest[0] === "list") { const st = r.status(); console.log(`budget ${st.usedToday}/${st.dailyTokens} tokens today`); for (const p of st.providers) console.log(`${p.name.padEnd(14)} ${p.role.padEnd(8)} ${p.kind}/${p.model}${p.keySet ? "" : "  (key missing)"}`); }
    else if (rest[0] === "wake") { const out = r.wake(sf.name ?? "", sf.role as "editor"); new Ledger(file).append({ actor: me, action: "provider.wake", summary: `${out.woke} awake as ${sf.role}`, source: "cli" }); console.log(JSON.stringify(out)); }
    else if (rest[0] === "sleep") { r.sleep(sf.name ?? ""); console.log("asleep"); }
    else if (rest[0] === "budget") { r.setBudget(Number(sf.tokens)); console.log("ok"); }
    else usage();
    break;
  }
  case "knowledge": {
    const sf = flags(rest.slice(1)), k = new KnowledgeStore(`${home}/knowledge`);
    if (rest[0] === "ingest") {
      const r = registry(), st = r.holder("steward");
      const out = await k.ingest(sf.path ?? "", readFileSync(sf.path ?? "", "utf8"), { ask: st ? async (system, prompt) => (await r.askSteward({ system, prompt, maxTokens: 600 })).text : undefined, maxChunks: sf.chunks ? Number(sf.chunks) : undefined });
      console.log(JSON.stringify(out) + (st ? "" : "\n(no steward awake: used the rule-based extractor)"));
    } else if (rest[0] === "search") for (const c of k.search(sf.q ?? "", 5)) console.log(`- ${c.technique}  [${c.source.doc}#${c.source.chunk}]`);
    else usage();
    break;
  }
  case "dispatch": {
    const sf = flags(rest), l = new Ledger(file);
    const r = await dispatch(steward(l), me, sf.task ?? "", { contract: sf.contract });
    console.log(`${r.id} (${r.status}, technique ${r.compiled.arm}, ${r.compiled.tokens} tokens from ${r.compiled.sourceTokens}${r.compiled.why ? `, LLM draft rejected: ${r.compiled.why}` : ""})\n\n${r.compiled.prompt}`);
    break;
  }
  case "queue": for (const q of queue(new Ledger(file))) console.log(`${q.id}  ${q.status.padEnd(16)} ${q.remote ? "remote " : "local  "} ${q.task}`); break;
  case "approve": console.log(approveDispatch(new Ledger(file), me, f.id ?? "").id); break;
  case "finish": console.log(JSON.stringify(finishDispatch(new Ledger(file), me, f.id ?? ""))); break;
  case "review": console.log(review(steward(new Ledger(file))).text); break;
  case "summary": console.log((await summarizeProject(steward(new Ledger(file)), f.name ?? "project")).text); break;
  case "projects": {
    const sf = flags(rest.slice(1)), P = new Projects(home);
    if (rest[0] === "add") { console.log(JSON.stringify(P.add(sf.name ?? "", sf.root ?? "."))); }
    else if (rest[0] === "list") for (const p of P.list) console.log(`${p.name}  ${p.root}`);
    else if (rest[0] === "summaries") for (const s of await P.summaries({ home })) console.log(s.text + "\n");
    else if (rest[0] === "consolidate") { const ls = P.consolidate(); for (const x of ls) console.log(`[${x.projects.join(",")}] ${x.text}`); if (!ls.length) console.log("nothing recurs across projects yet"); }
    else if (rest[0] === "lessons") for (const x of P.lessons()) console.log(`[${x.projects.join(",")}] ${x.text}`);
    else usage();
    break;
  }
  case "auth": {
    if (rest[0] !== "set-password") usage();
    const pw = process.env.HANDOFF_PASSWORD ?? readFileSync(0, "utf8").trim();
    setPassword(home, pw);
    console.log("password set (remote access still needs --allow-host and a tunnel)");
    break;
  }
  default:
    usage();
}
