// Minimal MCP server (JSON-RPC 2.0, newline-delimited over stdio). Zero dependencies.
// Any MCP-capable AI gets the project brief, the guardrails and scope checks through it. This is how tools we do not
// control (Cursor, Copilot agent mode, ...) are *told* the rules; blocking only happens where we sit in the path.
import { Ledger } from "./ledger.ts";
import { makeBrief, type Target } from "./handoff.ts";
import { addGuardrail, evaluate, liveGuardrails, loadGlobalGuardrails, logBlocked } from "./guardrails.ts";
import { takeNext } from "./steward.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { Projects } from "./projects.ts";
import { join } from "node:path";
import { acceptItem, audit, liveContracts, openContract, pathInScope } from "./scope.ts";

const PROTOCOL = "2024-11-05";
type Json = Record<string, any>;

export interface McpOptions {
  ledgerPath: string;
  agentName: string; // who is calling, as the ledger should record it (set per client by --agent)
  home?: string; // machine-wide rules, knowledge and lessons live here
}

const TOOLS = [
  { name: "get_brief", description: "Project memory: rules, decisions, open tasks, where the code stands. Call this first in every session.", inputSchema: { type: "object", properties: { budget_tokens: { type: "number" } } } },
  { name: "get_guardrails", description: "Rules every AI on this project must follow. 'block' rules are enforced; 'advise' rules are expected.", inputSchema: { type: "object", properties: {} } },
  { name: "check_action", description: "Ask BEFORE doing something risky. Returns allowed:false if a block rule matches. Blocked attempts are logged.", inputSchema: { type: "object", properties: { action: { type: "string", description: "file.edit | file.create | file.delete | command.run" }, target: { type: "string", description: "path or command" } }, required: ["action"] } },
  { name: "get_contracts", description: "Open task contracts: goal, acceptance criteria, allowed paths.", inputSchema: { type: "object", properties: {} } },
  { name: "check_scope", description: "Is this path inside the open contract's scope? Call before touching files outside the obvious area.", inputSchema: { type: "object", properties: { contract: { type: "string" }, path: { type: "string" } }, required: ["contract", "path"] } },
  { name: "confirm_acceptance", description: "Report that an acceptance item is met, with evidence. The human can still reverse it.", inputSchema: { type: "object", properties: { contract: { type: "string" }, item: { type: "number" }, evidence: { type: "string" } }, required: ["contract", "item"] } },
  { name: "audit_contract", description: "Done vs asked vs out-of-scope for a contract.", inputSchema: { type: "object", properties: { contract: { type: "string" } }, required: ["contract"] } },
  { name: "next_task", description: "Pull the next task the human approved for you. It comes as a compiled prompt that already includes the rules and scope. Returns 'none' if the queue is empty.", inputSchema: { type: "object", properties: {} } },
  { name: "find_technique", description: "Search distilled engineering/prompting techniques (from the owner's books and notes) relevant to what you are about to do.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_lessons", description: "General understandings that recur across the owner's projects.", inputSchema: { type: "object", properties: {} } },
  { name: "log_decision", description: "Record a decision and its reason so the next AI keeps it.", inputSchema: { type: "object", properties: { topic: { type: "string" }, decision: { type: "string" } }, required: ["decision"] } },
];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

export function callTool(o: McpOptions, name: string, a: Json) {
  const l = new Ledger(o.ledgerPath); // reopen: other processes append too
  const ai = { kind: "ai" as const, name: o.agentName };
  try {
    switch (name) {
      case "get_brief": {
        const b = makeBrief(l, o.agentName, "claude-md" as Target, typeof a.budget_tokens === "number" ? Math.min(8000, Math.max(300, a.budget_tokens)) : undefined);
        const g = o.home ? loadGlobalGuardrails(o.home) : [];
        return text(g.length ? `${b.text}\n## Machine-wide guardrails (every project)\n${g.map((x) => `- ${x.text} (${x.level})`).join("\n")}\n` : b.text);
      }
      case "get_guardrails": return json(liveGuardrails(l, o.home).map(({ level, text: t, match }) => ({ level, rule: t, match })));
      case "check_action": {
        const att = { action: String(a.action), target: a.target === undefined ? undefined : String(a.target) };
        const v = evaluate(liveGuardrails(l, o.home), att);
        if (!v.allowed) logBlocked(l, ai, att, v, "mcp");
        return json({ allowed: v.allowed, rules: v.violations.map((x) => ({ level: x.level, rule: x.text })) });
      }
      case "get_contracts": return json(liveContracts(l));
      case "check_scope": {
        const c = liveContracts(l).find((x) => x.id === a.contract);
        if (!c) return text(`no open contract ${a.contract}`, true);
        return json(pathInScope(c, String(a.path)));
      }
      case "confirm_acceptance": {
        acceptItem(l, ai, String(a.contract), Number(a.item), a.evidence ? String(a.evidence) : undefined);
        return text("recorded");
      }
      case "audit_contract": return text(audit(l, String(a.contract)).text);
      case "next_task": {
        const t = takeNext(l, ai);
        return t ? text(`Task ${t.id.slice(0, 8)} (${t.taskType}, technique: ${t.arm}${t.contract ? ", contract " + t.contract : ""}):\n\n${t.prompt}`) : text("none");
      }
      case "find_technique": {
        if (!o.home) return text("no knowledge store configured", true);
        const hits = new KnowledgeStore(join(o.home, "knowledge")).search(String(a.query ?? ""), 4);
        return hits.length ? text(hits.map((h) => `- ${h.technique}${h.when ? ` (when: ${h.when})` : ""}`).join("\n")) : text("no matching technique");
      }
      case "get_lessons": return o.home ? json(new Projects(o.home).lessons().map((x) => ({ lesson: x.text, projects: x.projects }))) : json([]);
      case "log_decision": {
        l.append({ actor: ai, aiInUse: o.agentName, action: "decision", target: a.topic ? String(a.topic) : undefined, summary: String(a.decision), source: "mcp" });
        return text("recorded");
      }
      default: return text(`unknown tool ${name}`, true);
    }
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

/** Pure request handler: returns the response object, or null for notifications. */
export function handle(o: McpOptions, msg: Json): Json | null {
  const id = msg.id;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return err(-32600, "invalid request");
  if (id === undefined) return null; // notification (initialized, cancelled, ...)
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "handoff-ledger", version: "0.2.0" }, instructions: "Call get_brief at the start of every session and get_guardrails before acting. Use check_action before risky commands or deletions, and log_decision for choices the next AI must keep." });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": return ok(callTool(o, String(msg.params?.name), (msg.params?.arguments ?? {}) as Json));
    case "resources/list": return ok({ resources: [
      { uri: "handoff://brief", name: "Project brief", mimeType: "text/markdown" },
      { uri: "handoff://guardrails", name: "Guardrails", mimeType: "application/json" },
      { uri: "handoff://contracts", name: "Open contracts", mimeType: "application/json" } ] });
    case "resources/read": {
      const uri = String(msg.params?.uri);
      const map: Record<string, [string, string]> = {
        "handoff://brief": ["text/markdown", callTool(o, "get_brief", {}).content[0]!.text],
        "handoff://guardrails": ["application/json", callTool(o, "get_guardrails", {}).content[0]!.text],
        "handoff://contracts": ["application/json", callTool(o, "get_contracts", {}).content[0]!.text],
      };
      const r = map[uri];
      return r ? ok({ contents: [{ uri, mimeType: r[0], text: r[1] }] }) : err(-32002, `unknown resource ${uri}`);
    }
    default: return err(-32601, `method not found: ${msg.method}`);
  }
}

export function serveStdio(o: McpOptions) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let out: Json | null;
      try { out = handle(o, JSON.parse(line)); } catch { out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }; }
      if (out) process.stdout.write(JSON.stringify(out) + "\n"); // stdout is protocol only; logs go to stderr
    }
  });
}
export { addGuardrail, openContract };
