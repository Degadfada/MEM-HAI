// Many projects, one mind. A registry of projects on this machine, per-project summaries, and "general understandings":
// facts that recur across projects, with citations back to the projects and events they came from.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Ledger } from "./ledger.ts";
import { extractFacts, type Fact } from "./facts.ts";
import { jaccardEstimate, minhash, shingles } from "./sketch.ts";
import { summarizeProject, type StewardDeps } from "./steward.ts";

export interface Project { name: string; root: string }
const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const ledgerPathFor = (root: string) => join(root, ".handoff", "ledger.jsonl");

export class Projects {
  readonly home: string;
  list: Project[] = [];
  constructor(home: string) {
    this.home = home;
    mkdirSync(home, { recursive: true });
    const f = join(home, "projects.json");
    if (existsSync(f)) this.list = JSON.parse(readFileSync(f, "utf8"));
  }
  private save() {
    const f = join(this.home, "projects.json"), t = f + ".tmp";
    writeFileSync(t, JSON.stringify(this.list, null, 2));
    renameSync(t, f);
  }
  add(name: string, root: string): Project {
    if (!NAME.test(name)) throw new Error("project name: lowercase letters, digits, - _");
    if (this.list.some((p) => p.name === name)) throw new Error(`project ${name} already exists`);
    const r = resolve(root);
    if (!existsSync(r) || !statSync(r).isDirectory()) throw new Error(`not a directory: ${r}`);
    if (this.list.some((p) => p.root === r)) throw new Error("that folder is already registered");
    const p = { name, root: r };
    this.list.push(p);
    this.save();
    return p;
  }
  remove(name: string) {
    if (!this.list.some((p) => p.name === name)) throw new Error(`no such project ${name}`);
    this.list = this.list.filter((p) => p.name !== name);
    this.save();
  }
  get(name: string): Project {
    const p = this.list.find((x) => x.name === name);
    if (!p) throw new Error(`no such project ${name}`);
    return p;
  }
  ledger(name: string): Ledger { return new Ledger(ledgerPathFor(this.get(name).root)); }

  /** Per-project summaries, each derived from that project's own raw ledger. */
  async summaries(d: Omit<StewardDeps, "ledger"> = {}): Promise<Array<{ name: string; text: string; events: number; via: string }>> {
    const out = [];
    for (const p of this.list) {
      if (!existsSync(ledgerPathFor(p.root))) { out.push({ name: p.name, text: `# ${p.name}\nNo ledger yet.`, events: 0, via: "rules" }); continue; }
      const l = new Ledger(ledgerPathFor(p.root));
      const s = await summarizeProject({ ...d, ledger: l }, p.name, join(p.root, ".handoff", "summary.md"));
      out.push({ name: p.name, text: s.text, events: s.basis.events, via: s.via });
    }
    return out;
  }

  private seeds(): number[] {
    const f = join(this.home, "seeds.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
    const s = Array.from({ length: 64 }, () => randomBytes(4).readUInt32BE(0));
    writeFileSync(f, JSON.stringify(s));
    return s;
  }

  /**
   * General understandings = facts that recur in two or more projects (rules, decisions, refusals, approval habits).
   * Re-derived from every project's raw ledger each time (never from earlier lessons).
   * File-level facts are excluded: they are specific to one codebase.
   */
  consolidate(minProjects = 2, threshold = 0.6): Lesson[] {
    const seeds = this.seeds();
    type Item = { project: string; fact: Fact; sig: number[] };
    const items: Item[] = [];
    for (const p of this.list) {
      if (!existsSync(ledgerPathFor(p.root))) continue;
      for (const f of extractFacts(new Ledger(ledgerPathFor(p.root)).all()))
        if (["constraint", "denial", "decision", "approval_pattern"].includes(f.kind)) items.push({ project: p.name, fact: f, sig: minhash(shingles(norm(f.text)), seeds) });
    }
    const parent = items.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        if (items[i]!.project === items[j]!.project || items[i]!.fact.kind !== items[j]!.fact.kind) continue;
        if (jaccardEstimate(items[i]!.sig, items[j]!.sig) >= threshold) parent[find(i)] = find(j);
      }
    const groups = new Map<number, Item[]>();
    items.forEach((it, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(it));
    const lessons: Lesson[] = [];
    for (const g of groups.values()) {
      const projects = [...new Set(g.map((x) => x.project))];
      if (projects.length < minProjects) continue;
      g.sort((a, b) => a.fact.text.length - b.fact.text.length);
      lessons.push({ text: g[0]!.fact.text, kind: g[0]!.fact.kind, projects: projects.sort(), sources: g.map((x) => ({ project: x.project, eventId: x.fact.sources[x.fact.sources.length - 1]! })) });
    }
    lessons.sort((a, b) => b.projects.length - a.projects.length || a.text.localeCompare(b.text));
    const tmp = join(this.home, "lessons.json.tmp");
    writeFileSync(tmp, JSON.stringify({ basis: this.list.map((p) => ({ project: p.name, events: existsSync(ledgerPathFor(p.root)) ? new Ledger(ledgerPathFor(p.root)).length : 0 })), lessons }, null, 2));
    renameSync(tmp, join(this.home, "lessons.json"));
    return lessons;
  }
  lessons(): Lesson[] {
    try { return JSON.parse(readFileSync(join(this.home, "lessons.json"), "utf8")).lessons; } catch { return []; }
  }
}
export interface Lesson { text: string; kind: string; projects: string[]; sources: Array<{ project: string; eventId: string }> }
const norm = (t: string) => t.replace(/^(RULE|GUARDRAIL[^:]*|Decision \([^)]*\)|Human DENIED[^:]*):\s*/i, "").replace(/\[[0-9a-f]{8}\]/g, "");
