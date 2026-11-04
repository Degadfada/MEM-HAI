// Provider registry: which AIs are plugged in, which are awake (max one editor + one steward), and what they may spend.
// Keys are never stored: a provider names an environment variable, read at call time.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordExchange, statedReason } from "./exchange.ts";
import type { Rationale } from "./types.ts";

// "openai-compatible" is deliberately generic: Kimi/Moonshot, DeepSeek, Groq, OpenRouter, vLLM,
// LM Studio and OpenAI itself all speak /v1/chat/completions, so one adapter plus a baseUrl
// reaches most of the field instead of one hand-written vendor branch each.
export type Kind = "anthropic" | "gemini" | "ollama" | "openai-compatible";
export type Role = "editor" | "steward" | "asleep";
export interface ProviderConfig {
  name: string;
  kind: Kind;
  model: string;
  baseUrl?: string;
  keyEnv?: string; // name of the env var holding the API key (not the key)
  role: Role;
}
export interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
  latencyMs?: number;
  /** What we sent. Kept so the exchange can be recorded as evidence rather than reconstructed. */
  request?: { system?: string; prompt: string };
}
export interface CompleteRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  /** The human instruction behind this call. Falls back to the prompt when the caller knows no better. */
  ask?: string;
  /** Who approved the task this call serves. */
  approvedBy?: string;
  /** The dispatch this call serves, so the exchange and the task can be joined later. */
  dispatchId?: string;
}

type Fetch = typeof fetch;
const DEFAULT_BASE: Record<Kind, string> = {
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434",
  "openai-compatible": "https://api.openai.com",
};
export const KINDS: Kind[] = ["anthropic", "gemini", "ollama", "openai-compatible"];
/** Kinds that talk to a service needing no key, so keyEnv is optional for them. */
const KEYLESS: Kind[] = ["ollama"];

/**
 * One wire format per entry. Adding a vendor is an entry here, not a new branch threaded through
 * request building, response parsing and error handling.
 */
interface Adapter {
  url: (base: string, model: string) => string;
  headers?: (key: string | undefined) => Record<string, string>;
  body: (model: string, req: CompleteRequest, max: number) => unknown;
  parse: (j: any) => { text: string; inputTokens: number; outputTokens: number };
}

const ADAPTERS: Record<Kind, Adapter> = {
  anthropic: {
    url: (base) => `${base}/v1/messages`,
    headers: (key) => ({ "x-api-key": key!, "anthropic-version": "2023-06-01" }),
    body: (model, req, max) => ({
      model, max_tokens: max,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: "user", content: req.prompt }],
    }),
    parse: (j) => ({
      text: (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
      inputTokens: j.usage?.input_tokens ?? 0,
      outputTokens: j.usage?.output_tokens ?? 0,
    }),
  },
  gemini: {
    url: (base, model) => `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: (key) => ({ "x-goog-api-key": key! }),
    body: (_model, req, max) => ({
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: { maxOutputTokens: max },
    }),
    parse: (j) => ({
      text: (j.candidates?.[0]?.content?.parts ?? []).map((x: any) => x.text ?? "").join(""),
      inputTokens: j.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0,
    }),
  },
  ollama: {
    url: (base) => `${base}/api/chat`,
    body: (model, req, max) => ({
      model, stream: false, options: { num_predict: max },
      messages: [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }],
    }),
    parse: (j) => ({
      text: j.message?.content ?? "",
      inputTokens: j.prompt_eval_count ?? 0,
      outputTokens: j.eval_count ?? 0,
    }),
  },
  "openai-compatible": {
    url: (base) => `${base}/v1/chat/completions`,
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    body: (model, req, max) => ({
      model, max_tokens: max,
      messages: [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }],
    }),
    parse: (j) => {
      const m = j.choices?.[0]?.message;
      // Some gateways answer with content as an array of parts rather than a string.
      const text = typeof m?.content === "string"
        ? m.content
        : Array.isArray(m?.content) ? m.content.map((c: any) => c.text ?? "").join("") : "";
      return { text, inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 };
    },
  },
};
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const DEFAULT_DAILY_TOKENS = 200_000;

export class BudgetError extends Error {}

/**
 * Make one call and return both sides of it. `fetchFn` is injectable so tests speak to a fake server.
 *
 * We are the client here, which is the whole reason API-driven AIs can reach `recorded` provenance:
 * the prompt we sent and the answer we got are primary evidence in our own process, not something
 * scraped out of a vendor log that may be reformatted or cleared.
 */
export async function callProvider(p: ProviderConfig, req: CompleteRequest, fetchFn: Fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<Completion> {
  const a = ADAPTERS[p.kind];
  if (!a) throw new Error(`provider ${p.name}: unknown kind ${p.kind}`);
  const base = (p.baseUrl ?? DEFAULT_BASE[p.kind]).replace(/\/+$/, "");
  const max = Math.min(req.maxTokens ?? 1024, 8192);
  const key = p.keyEnv ? env[p.keyEnv] : undefined;
  if (!KEYLESS.includes(p.kind) && !key) throw new Error(`provider ${p.name}: environment variable ${p.keyEnv ?? "(none set)"} is empty`);

  const url = a.url(base, p.model);
  const headers = { "content-type": "application/json", ...(a.headers ? a.headers(key) : {}) };
  const body = a.body(p.model, req, max);
  const startedAt = Date.now();

  const res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const raw = await res.text();
  // Never let a key reach an error message, a log or the ledger.
  if (!res.ok) throw new Error(`provider ${p.name}: HTTP ${res.status} ${raw.slice(0, 200).replace(key ?? "\u0000", "[key]")}`);
  let j: any;
  try { j = JSON.parse(raw); } catch { throw new Error(`provider ${p.name}: reply was not JSON`); }

  const out = a.parse(j);
  return {
    ...out,
    provider: p.name,
    model: p.model,
    latencyMs: Date.now() - startedAt,
    request: { system: req.system, prompt: req.prompt },
  };
}

export interface RegistryOptions {
  home: string; // directory holding providers.json and usage.json
  fetch?: Fetch;
  env?: NodeJS.ProcessEnv;
  today?: () => string; // YYYY-MM-DD, injectable for tests
  // audit hook (project ledger). Carries the rationale so a recorded exchange reaches the ledger.
  onEvent?: (e: { action: string; summary?: string; payload?: Record<string, unknown>; rationale?: Rationale }) => void;
}

export class Registry {
  private o: Required<Omit<RegistryOptions, "onEvent">> & Pick<RegistryOptions, "onEvent">;
  providers: ProviderConfig[] = [];
  dailyTokens = DEFAULT_DAILY_TOKENS;

  constructor(o: RegistryOptions) {
    this.o = { fetch: fetch, env: process.env, today: () => new Date().toISOString().slice(0, 10), ...o };
    mkdirSync(o.home, { recursive: true });
    const f = join(o.home, "providers.json");
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, "utf8"));
      this.providers = j.providers ?? [];
      this.dailyTokens = j.dailyTokens ?? DEFAULT_DAILY_TOKENS;
    }
  }

  private save() {
    const f = join(this.o.home, "providers.json"), tmp = f + ".tmp";
    writeFileSync(tmp, JSON.stringify({ dailyTokens: this.dailyTokens, providers: this.providers }, null, 2));
    renameSync(tmp, f);
  }

  get(name: string): ProviderConfig {
    const p = this.providers.find((x) => x.name === name);
    if (!p) throw new Error(`no such provider ${name}`);
    return p;
  }

  add(c: Omit<ProviderConfig, "role"> & { role?: Role }): ProviderConfig {
    if (!NAME.test(c.name)) throw new Error("provider name: lowercase letters, digits, - _ (max 32)");
    if (this.providers.some((p) => p.name === c.name)) throw new Error(`provider ${c.name} already exists`);
    if (!KINDS.includes(c.kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
    if (!c.model?.trim()) throw new Error("model required");
    if (!KEYLESS.includes(c.kind) && !c.keyEnv) throw new Error("keyEnv required (the NAME of the environment variable holding the key)");
    if (c.keyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(c.keyEnv)) throw new Error("keyEnv must look like ANTHROPIC_API_KEY (a variable name, not the key itself)");
    if (c.baseUrl) {
      const u = new URL(c.baseUrl);
      const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
      if (u.protocol !== "https:" && !local) throw new Error("baseUrl must be https unless it is localhost");
    }
    const p: ProviderConfig = { ...c, role: "asleep" };
    this.providers.push(p);
    this.save();
    return p;
  }

  remove(name: string) {
    this.get(name);
    this.providers = this.providers.filter((p) => p.name !== name);
    this.save();
  }

  /** Wake a provider into a role. Only one editor and one steward at a time: the previous holder is put to sleep. */
  wake(name: string, role: "editor" | "steward"): { woke: string; slept: string[] } {
    const p = this.get(name);
    const slept: string[] = [];
    for (const q of this.providers) if (q.role === role && q.name !== name) { q.role = "asleep"; slept.push(q.name); }
    // a provider holds one role at a time
    p.role = role;
    this.save();
    this.o.onEvent?.({ action: "provider.wake", summary: `${name} awake as ${role}${slept.length ? `; ${slept.join(", ")} put to sleep` : ""}`, payload: { name, role, slept } });
    return { woke: name, slept };
  }

  sleep(name: string) {
    const p = this.get(name);
    p.role = "asleep";
    this.save();
    this.o.onEvent?.({ action: "provider.sleep", summary: `${name} put to sleep`, payload: { name } });
  }

  awake(): ProviderConfig[] {
    return this.providers.filter((p) => p.role !== "asleep");
  }
  holder(role: "editor" | "steward"): ProviderConfig | undefined {
    return this.providers.find((p) => p.role === role);
  }

  setBudget(dailyTokens: number) {
    if (!Number.isFinite(dailyTokens) || dailyTokens < 0) throw new Error("dailyTokens must be >= 0");
    this.dailyTokens = Math.floor(dailyTokens);
    this.save();
  }

  private usageFile() { return join(this.o.home, "usage.json"); }
  usedToday(): number {
    try { return (JSON.parse(readFileSync(this.usageFile(), "utf8")) as Record<string, number>)[this.o.today()] ?? 0; } catch { return 0; }
  }
  private addUsage(n: number) {
    let u: Record<string, number> = {};
    try { u = JSON.parse(readFileSync(this.usageFile(), "utf8")); } catch {}
    const d = this.o.today();
    u[d] = (u[d] ?? 0) + n;
    for (const k of Object.keys(u).sort().slice(0, -30)) delete u[k]; // keep 30 days
    writeFileSync(this.usageFile(), JSON.stringify(u));
  }

  /** Call an AI. Asleep providers refuse. The budget is checked BEFORE the call (prompt estimate + max output) and updated after. */
  async complete(name: string, req: CompleteRequest): Promise<Completion> {
    const p = this.get(name);
    if (p.role === "asleep") throw new Error(`provider ${name} is asleep; wake it first`);
    const worst = Math.ceil(((req.system?.length ?? 0) + req.prompt.length) / 4) + Math.min(req.maxTokens ?? 1024, 8192);
    if (this.usedToday() + worst > this.dailyTokens) throw new BudgetError(`daily token budget reached (${this.usedToday()} used of ${this.dailyTokens}); raise it with setBudget`);
    const out = await callProvider(p, req, this.o.fetch, this.o.env);
    this.addUsage(out.inputTokens + out.outputTokens || Math.ceil(worst / 2));

    // Keep both sides of the exchange. We made this call, so this is primary evidence, and it is the
    // reason an API-driven AI can answer "why" as well as a hooked one. A failure to write the
    // evidence must not fail the call: the work still happened, it is the record that is poorer.
    let rationale: Rationale | undefined;
    try {
      const ex = recordExchange(this.o.home, out, { dispatchId: req.dispatchId });
      rationale = {
        provenance: "recorded",
        ask: req.ask ?? req.prompt,
        reason: statedReason(out.text),
        ...(req.approvedBy ? { approvedBy: req.approvedBy } : {}),
        ref: { exchangeSha256: ex.sha256, ...(req.dispatchId ? { dispatchId: req.dispatchId } : {}) },
      };
    } catch { /* evidence store unwritable: fall through with no rationale rather than losing the call */ }

    this.o.onEvent?.({
      action: "ai.usage",
      summary: `${name} used ${out.inputTokens + out.outputTokens} tokens`,
      payload: { name, model: p.model, inputTokens: out.inputTokens, outputTokens: out.outputTokens, latencyMs: out.latencyMs, exchangeSha256: rationale?.ref?.exchangeSha256 },
      rationale,
    });
    return out;
  }

  /** Ask the steward. Fails clearly if no steward is awake. */
  async askSteward(req: CompleteRequest): Promise<Completion> {
    const s = this.holder("steward");
    if (!s) throw new Error("no steward is awake; wake one with wake(name, 'steward')");
    return this.complete(s.name, req);
  }

  status() {
    return { dailyTokens: this.dailyTokens, usedToday: this.usedToday(), providers: this.providers.map((p) => ({ name: p.name, kind: p.kind, model: p.model, role: p.role, keySet: KEYLESS.includes(p.kind) ? true : !!(p.keyEnv && this.o.env[p.keyEnv]) })) };
  }
}
