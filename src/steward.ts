// The steward: the layer above the AIs. It keeps asked-vs-done honest, compiles high-value prompts from many contexts,
// queues tasks for the editor AI, and writes per-project summaries. Every LLM output is checked before use;
// when the LLM is absent, over budget, or wrong, the deterministic path produces a usable result.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Ledger } from "./ledger.ts";
import { makeBrief } from "./handoff.ts";
import { liveGuardrails } from "./guardrails.ts";
import { audit, liveContracts, type Audit } from "./scope.ts";
import { extractFacts } from "./facts.ts";
import { estimateTokens } from "./score.ts";
import { classifyTask, Learner, loadOutcomes, type Arm, type TaskType } from "./learn.ts";
import type { Ask } from "./knowledge.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { redactString } from "./redact.ts";

export interface StewardDeps {
  ledger: Ledger;
  ask?: Ask; // present only when a steward AI is awake
  knowledge?: KnowledgeStore;
  rng?: () => number;
  home?: string; // machine-wide guardrails live here
}

const STOP = new Set("the and for with that this from not use are was were has have had can will into onto when then than but you your our its all any one new set get got per via not".split(" "));
const tok = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9_./-]+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** Does `text` carry (almost) every content word of `rule`? Used to prove an LLM did not drop a rule. */
export function carries(text: string, rule: string): boolean {
  const need = [...tok(rule)], have = tok(text);
  if (!need.length) return true;
  return need.filter((w) => have.has(w)).length / need.length >= 0.85;
}

const TECHNIQUE_LINE: Record<Arm, string> = {
  "goal-first": "",
  "constraints-sandwich": "",
  "minimal-diff": "Make the smallest change that satisfies the goal. Before editing, list the files you will touch; touch nothing else.",
  "test-first": "Start by writing a failing test that captures the goal, then make the smallest change that passes it.",
  "plan-then-act": "First reply with a short numbered plan. Then execute it step by step, confirming each acceptance item with evidence.",
  precedents: "Follow the precedents below; if you must deviate, say why before doing it.",
};

export interface Compiled {
  prompt: string;
  arm: Arm;
  taskType: TaskType;
  via: "llm" | "rules";
  why?: string; // why the LLM draft was rejected, if it was
  tokens: number;
  sourceTokens: number; // size of everything it was distilled from
  hardRules: number;
  cards: string[];
}

export async function compilePrompt(d: StewardDeps, task: string, o: { contract?: string; maxTokens?: number } = {}): Promise<Compiled> {
  const l = d.ledger, max = Math.max(150, o.maxTokens ?? 600);
  const taskType = classifyTask(task);
  const rules = liveGuardrails(l, d.home).map((g) => `${g.text}${g.level === "block" ? " (enforced)" : ""}`);
  const hardFacts = extractFacts(l.all()).filter((f) => f.hard && !f.text.startsWith("GUARDRAIL")).map((f) => f.text.replace(/^RULE: /, ""));
  const allRules = [...new Set([...hardFacts, ...rules])];
  const contract = o.contract ? liveContracts(l).find((c) => c.id === o.contract) : undefined;
  if (o.contract && !contract) throw new Error(`no open contract ${o.contract}`);

  const learner = new Learner(loadOutcomes(l));
  const choice = learner.choose(taskType, { hardRules: allRules.length, hasContract: !!contract, promptTokens: max }, d.rng);
  const arm = choice.arm;

  // relevant context: facts sharing words with the task
  const tt = tok(task);
  const facts = extractFacts(l.all()).filter((f) => !f.hard && ["decision", "task", "file"].includes(f.kind));
  const rel = facts.map((f) => ({ f, s: [...tok(f.text)].filter((w) => tt.has(w)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, arm === "precedents" ? 5 : 3).map((x) => x.f.text);
  const cards = (d.knowledge?.search(task, 2) ?? []).map((c) => c.technique);

  const goal = `GOAL: ${task.trim()}${contract?.acceptance.length ? `\nDONE WHEN: ${contract.acceptance.join("; ")}` : ""}`;
  const scope = contract ? `SCOPE: ${contract.inScope.length ? "only touch " + contract.inScope.join(", ") : "any path"}${contract.outOfScope.length ? "; never touch " + contract.outOfScope.join(", ") : ""}` : "";
  const ruleBlock = allRules.length ? `RULES (binding):\n${allRules.map((r) => "- " + r).join("\n")}` : "";
  const ctxBlock = rel.length ? `${arm === "precedents" ? "PRECEDENTS" : "CONTEXT"}:\n${rel.map((r) => "- " + r).join("\n")}` : "";
  const tech = TECHNIQUE_LINE[arm];
  const cardBlock = cards.length ? `GUIDANCE:\n${cards.map((c) => "- " + c).join("\n")}` : "";
  const tail = arm === "constraints-sandwich" && allRules.length ? `REMEMBER: ${allRules.slice(0, 3).join("; ")}` : "";
  const parts = arm === "constraints-sandwich" ? [ruleBlock, goal, scope, ctxBlock, tech, cardBlock, tail] : [goal, scope, ruleBlock, ctxBlock, tech, cardBlock, tail];
  const draft = parts.filter(Boolean).join("\n\n");

  // everything this prompt stands in for (for the compression figure)
  const source = makeBrief(l, "editor", "claude-md", 100000).text + "\n" + cards.join("\n") + "\n" + task;
  const sourceTokens = estimateTokens(source);

  let prompt = draft, via: Compiled["via"] = "rules", why: string | undefined;
  if (d.ask && estimateTokens(draft) > 40) {
    try {
      const reply = (await d.ask(
        "You compress an instruction for a coding AI into the fewest words that keep every requirement. Keep every RULE and the GOAL and DONE WHEN items. Do not add requirements, files, or facts that are not in the input. Reply with ONLY the compressed instruction.",
        `Compress to at most ${max} tokens:\n\n${draft}`)).trim();
      const missing = allRules.filter((r) => !carries(reply, r));
      if (!reply) why = "empty reply";
      else if (missing.length) why = `dropped rule: ${missing[0]}`;
      else if (!carries(reply, task)) why = "dropped the goal";
      else if (estimateTokens(reply) > estimateTokens(draft)) why = "longer than the draft";
      else if (estimateTokens(reply) > max) why = "over the token cap";
      else (prompt = reply), (via = "llm");
    } catch (e) { why = (e as Error).message.slice(0, 120); }
  }
  if (estimateTokens(prompt) > max) { // deterministic trim: drop optional blocks, never rules or goal
    prompt = [goal, scope, ruleBlock, tech].filter(Boolean).join("\n\n");
  }
  prompt = redactString(prompt).text;
  return { prompt, arm, taskType, via, why, tokens: estimateTokens(prompt), sourceTokens, hardRules: allRules.length, cards };
}

// ---------- dispatch queue ----------
export type Source = "local" | "remote";

export async function dispatch(d: StewardDeps, by: { kind: "human"; name: string }, task: string, o: { contract?: string; source?: Source; maxTokens?: number } = {}) {
  if (!task.trim()) throw new Error("task required");
  const c = await compilePrompt(d, task, o);
  const remote = o.source === "remote";
  const ev = d.ledger.append({
    actor: { kind: "system", name: "steward" }, action: "dispatch", summary: task.trim().slice(0, 200),
    payload: { taskType: c.taskType, arm: c.arm, prompt: c.prompt, promptTokens: c.tokens, hardRules: c.hardRules, contract: o.contract, requestedBy: by.name, via: c.via },
    source: remote ? "remote" : "local",
  });
  if (!remote) d.ledger.append({ actor: by, action: "dispatch.approve", target: ev.id, source: "local", approval: { status: "approved", by: by.name, at: new Date().toISOString() } });
  return { id: ev.id, compiled: c, status: remote ? "pending-approval" : "approved" };
}

export function approveDispatch(l: Ledger, by: { kind: "human"; name: string }, id: string) {
  const e = l.get(id);
  if (!e || e.action !== "dispatch") throw new Error(`not a dispatch: ${id}`);
  if (l.all().some((x) => x.action === "dispatch.approve" && x.target === id && x.delta === 1 && !l.isReversed(x.id))) throw new Error("already approved");
  return l.append({ actor: by, action: "dispatch.approve", target: id, source: "local", approval: { status: "approved", by: by.name, at: new Date().toISOString() } });
}

export interface QueueItem { id: string; task: string; status: "pending-approval" | "approved" | "taken" | "finished"; taskType: string; arm: string; prompt: string; contract?: string; remote: boolean; ts: string }
export function queue(l: Ledger): QueueItem[] {
  const ev = l.all();
  return ev.filter((e) => e.action === "dispatch" && e.delta === 1 && !l.isReversed(e.id)).map((e) => {
    const has = (a: string) => ev.some((x) => x.action === a && x.target === e.id && x.delta === 1 && !l.isReversed(x.id));
    const p = e.payload as any;
    return { id: e.id, task: e.summary ?? "", status: has("dispatch.done") ? "finished" : has("dispatch.taken") ? "taken" : has("dispatch.approve") ? "approved" : "pending-approval", taskType: p.taskType, arm: p.arm, prompt: p.prompt, contract: p.contract, remote: e.source === "remote", ts: e.ts } as QueueItem;
  });
}

/** The editor AI pulls its next compiled task (oldest approved first). */
export function takeNext(l: Ledger, who: { kind: "ai"; name: string }): QueueItem | null {
  const next = queue(l).find((q) => q.status === "approved");
  if (!next) return null;
  l.append({ actor: who, aiInUse: who.name, action: "dispatch.taken", target: next.id, source: "mcp" });
  return { ...next, status: "taken" };
}

// ---------- review & summaries ----------
export interface Review { audits: Audit[]; suggestions: string[]; blocked: number; text: string }

export function review(d: StewardDeps): Review {
  const l = d.ledger;
  const audits = liveContracts(l).map((c) => audit(l, c.id));
  const suggestions: string[] = [];
  for (const a of audits) {
    if (a.verdict === "drifting") {
      suggestions.push(`${a.contract.id}: the AI touched ${a.outOfScope.length} path(s) outside scope. Re-state "never touch ${a.outOfScope.slice(0, 2).map((o) => o.target).join(", ")}" in the prompt, or add a block guardrail for it.`);
    }
    if (a.workEvents >= 5 && a.accepted.length === 0 && a.contract.acceptance.length)
      suggestions.push(`${a.contract.id}: ${a.workEvents} changes and no acceptance item confirmed. Ask the AI to call confirm_acceptance with evidence, or compile a plan-then-act prompt.`);
    if (a.verdict === "no-work-yet") suggestions.push(`${a.contract.id}: opened but no work recorded yet. Dispatch it to the editor AI.`);
    if (a.verdict === "complete" && !a.closed) suggestions.push(`${a.contract.id}: all acceptance items confirmed. Close it so it stops appearing in briefs.`);
  }
  const pending = queue(l).filter((q) => q.status === "pending-approval").length;
  if (pending) suggestions.push(`${pending} remote task(s) wait for your approval.`);
  const blocked = l.all().filter((e) => e.action === "guardrail.blocked" && e.delta === 1).length;
  if (blocked >= 3) suggestions.push(`${blocked} guardrail blocks so far. Repeated blocks usually mean the prompt does not state the rule. Compile prompts through the steward so rules are always included.`);
  const text = [audits.length ? audits.map((a) => a.text).join("\n\n") : "No open contracts.", suggestions.length ? "\nSuggestions:\n" + suggestions.map((s) => "- " + s).join("\n") : ""].join("\n");
  return { audits, suggestions, blocked, text };
}

export async function summarizeProject(d: StewardDeps, name: string, outFile?: string): Promise<{ text: string; basis: { events: number; hash: string }; via: "llm" | "rules" }> {
  const l = d.ledger, ev = l.all();
  const facts = extractFacts(ev);
  const by = (k: string) => facts.filter((f) => f.kind === k).map((f) => f.text);
  const trail: string[] = [];
  for (const e of ev) if (e.delta === 1 && !l.isReversed(e.id) && e.aiInUse && trail[trail.length - 1] !== e.aiInUse) trail.push(e.aiInUse);
  const rv = review(d);
  const basis = { events: ev.length, hash: ev.length ? ev[ev.length - 1]!.hash.slice(0, 12) : "genesis" };
  const det = [
    `# ${name}`,
    `AIs used: ${trail.join(" → ") || "none"}. ${ev.filter((e) => e.actor.kind === "ai").length} AI actions, ${ev.filter((e) => e.actor.kind === "human").length} human actions.`,
    by("constraint").length ? `Rules: ${by("constraint").join(" | ")}` : "",
    by("decision").length ? `Decisions: ${by("decision").slice(-6).join(" | ")}` : "",
    by("task").length ? `Open: ${by("task").join(" | ")}` : "",
    rv.suggestions.length ? `Attention: ${rv.suggestions.join(" ")}` : "On track.",
  ].filter(Boolean).join("\n");
  let text = det, via: "llm" | "rules" = "rules";
  if (d.ask) {
    try {
      const r = (await d.ask("Write a status summary of a software project in under 120 words, plain prose, for its owner. Use only the facts given. Do not invent progress.", det)).trim();
      if (r && estimateTokens(r) < 400) (text = `# ${name}\n${r}\n\n(derived from ${basis.events} events, ledger ${basis.hash})`), (via = "llm");
    } catch { /* keep the deterministic summary */ }
  }
  if (via === "rules") text += `\n\n(derived from ${basis.events} events, ledger ${basis.hash})`;
  if (outFile) { mkdirSync(dirname(outFile), { recursive: true }); writeFileSync(outFile, text + "\n"); }
  return { text, basis, via };
}
