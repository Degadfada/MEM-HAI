// Provider registry: which AIs are plugged in, which are awake (max one editor + one steward), and what they may spend.
// Keys are never stored: a provider names an environment variable, read at call time.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Kind = "anthropic" | "gemini" | "ollama";
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
}
export interface CompleteRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
}

type Fetch = typeof fetch;
const DEFAULT_BASE: Record<Kind, string> = {
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434",
};
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const DEFAULT_DAILY_TOKENS = 200_000;

export class BudgetError extends Error {}

/** One wire-format adapter per vendor. `fetchFn` is injectable so tests can speak to a fake server. */
export async function callProvider(p: ProviderConfig, req: CompleteRequest, fetchFn: Fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<Completion> {
  const base = (p.baseUrl ?? DEFAULT_BASE[p.kind]).replace(/\/+$/, "");
  const max = Math.min(req.maxTokens ?? 1024, 8192);
  const key = p.keyEnv ? env[p.keyEnv] : undefined;
  if (p.kind !== "ollama" && !key) throw new Error(`provider ${p.name}: environment variable ${p.keyEnv ?? "(none set)"} is empty`);
  let url: string, headers: Record<string, string> = { "content-type": "application/json" }, body: unknown;

  if (p.kind === "anthropic") {
    url = `${base}/v1/messages`;
    headers = { ...headers, "x-api-key": key!, "anthropic-version": "2023-06-01" };
    body = { model: p.model, max_tokens: max, ...(req.system ? { system: req.system } : {}), messages: [{ role: "user", content: req.prompt }] };
  } else if (p.kind === "gemini") {
    url = `${base}/v1beta/models/${encodeURIComponent(p.model)}:generateContent`;
    headers = { ...headers, "x-goog-api-key": key! };
    body = { ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}), contents: [{ role: "user", parts: [{ text: req.prompt }] }], generationConfig: { maxOutputTokens: max } };
  } else {
    url = `${base}/api/chat`;
    body = { model: p.model, stream: false, options: { num_predict: max }, messages: [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }] };
  }

  const res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`provider ${p.name}: HTTP ${res.status} ${raw.slice(0, 200).replace(key ?? "\u0000", "[key]")}`);
  let j: any;
  try { j = JSON.parse(raw); } catch { throw new Error(`provider ${p.name}: reply was not JSON`); }

  if (p.kind === "anthropic") {
    const text = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0, provider: p.name, model: p.model };
  }
  if (p.kind === "gemini") {
    const text = (j.candidates?.[0]?.content?.parts ?? []).map((x: any) => x.text ?? "").join("");
    return { text, inputTokens: j.usageMetadata?.promptTokenCount ?? 0, outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0, provider: p.name, model: p.model };
  }
  return { text: j.message?.content ?? "", inputTokens: j.prompt_eval_count ?? 0, outputTokens: j.eval_count ?? 0, provider: p.name, model: p.model };
}

export interface RegistryOptions {
  home: string; // directory holding providers.json and usage.json
  fetch?: Fetch;
  env?: NodeJS.ProcessEnv;
  today?: () => string; // YYYY-MM-DD, injectable for tests
  onEvent?: (e: { action: string; summary: string; payload?: Record<string, unknown> }) => void; // audit hook (project ledger)
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
    if (!["anthropic", "gemini", "ollama"].includes(c.kind)) throw new Error("kind must be anthropic, gemini or ollama");
    if (!c.model?.trim()) throw new Error("model required");
    if (c.kind !== "ollama" && !c.keyEnv) throw new Error("keyEnv required (the NAME of the environment variable holding the key)");
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
    this.o.onEvent?.({ action: "ai.usage", summary: `${name} used ${out.inputTokens + out.outputTokens} tokens`, payload: { name, model: p.model, inputTokens: out.inputTokens, outputTokens: out.outputTokens } });
    return out;
  }

  /** Ask the steward. Fails clearly if no steward is awake. */
  async askSteward(req: CompleteRequest): Promise<Completion> {
    const s = this.holder("steward");
    if (!s) throw new Error("no steward is awake; wake one with wake(name, 'steward')");
    return this.complete(s.name, req);
  }

  status() {
    return { dailyTokens: this.dailyTokens, usedToday: this.usedToday(), providers: this.providers.map((p) => ({ name: p.name, kind: p.kind, model: p.model, role: p.role, keySet: p.kind === "ollama" ? true : !!(p.keyEnv && this.o.env[p.keyEnv]) })) };
  }
}
