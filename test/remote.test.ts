import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, copyFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { setPassword, checkPassword, makeThrottle, Sessions, cookieOf } from "../src/auth.ts";
import { Ledger } from "../src/ledger.ts";
import { Registry } from "../src/providers.ts";
import { addGlobalGuardrail } from "../src/guardrails.ts";
import { openContract } from "../src/scope.ts";
import { sampleLedger } from "./helpers.ts";
import { fakeAi } from "./fakeai.ts";

const PASSWORD = "correct horse battery staple";
const HOST = "handoff.example.com";
const dir = mkdtempSync(join(tmpdir(), "rem-")), home = mkdtempSync(join(tmpdir(), "home-"));
const lp = join(dir, "ledger.jsonl");
copyFileSync(sampleLedger().path, lp);
openContract(new Ledger(lp), { kind: "human", name: "me" }, { id: "login-limit", goal: "Rate limit login", acceptance: ["429 after 5"], inScope: ["src/auth/**"] });
process.env.K = "test-key"; // the server reads provider keys from the environment, like a real run
const ai = await fakeAi((p) => p.split("\n\n").slice(1).join("\n\n").replace(/\n+/g, " "));
const reg = new Registry({ home, env: { K: "k" } as any });
reg.add({ name: "claude", kind: "anthropic", model: "m", keyEnv: "K", baseUrl: ai.url });
reg.add({ name: "llama", kind: "ollama", model: "m", baseUrl: ai.url });
const srv = await startServer({ ledgerPath: lp, projectRoot: dir, home, allowHosts: [HOST], fetch: ((u: any, i: any) => fetch(u, i)) as typeof fetch });
after(async () => { await srv.close(); await ai.close(); });

/** Real HTTP with a chosen Host header, like traffic arriving through a tunnel. */
function req(method: string, path: string, o: { host?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }>((ok, fail) => {
    const r = http.request({ host: "127.0.0.1", port: srv.port, method, path, headers: { host: o.host ?? `127.0.0.1:${srv.port}`, "content-type": "application/json", ...o.headers } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, json: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null }));
    });
    r.on("error", fail);
    if (o.body !== undefined) r.write(JSON.stringify(o.body));
    r.end();
  });
}
const local = (m: string, p: string, body?: unknown) => req(m, p, { headers: { authorization: `Bearer ${srv.token}` }, body });
const fwd = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
async function login(ip = "203.0.113.9", pw = PASSWORD) {
  return req("POST", "/login", { host: HOST, headers: { ...fwd, "x-forwarded-for": ip }, body: { password: pw } });
}

test("remote access is OFF until a password exists", async () => {
  const r = await req("GET", "/api/summary", { host: HOST, headers: fwd });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /remote access is off/);
  // and forwarding headers on a loopback Host are treated as remote too (a tunnel that forgets to rewrite Host)
  assert.equal((await req("GET", "/api/summary", { headers: { ...fwd, authorization: `Bearer ${srv.token}` } })).status, 403);
  setPassword(home, PASSWORD);
});

test("password storage: scrypt hash, owner-only file, no plaintext; min length", () => {
  assert.throws(() => setPassword(home, "short"), /at least 12/);
  const raw = readFileSync(join(home, "auth.json"), "utf8");
  assert.ok(!raw.includes(PASSWORD));
  assert.equal(statSync(join(home, "auth.json")).mode & 0o077, 0, "file must not be group/world readable");
  assert.equal(checkPassword(home, PASSWORD), true);
  assert.equal(checkPassword(home, PASSWORD + "x"), false);
});

test("unknown Host is refused even with a valid session; allowed Host without login gets 401", async () => {
  assert.equal((await req("GET", "/api/summary", { host: "evil.example", headers: fwd })).status, 403);
  assert.equal((await req("GET", "/api/summary", { host: HOST, headers: fwd })).status, 401);
  assert.equal((await req("GET", "/", { host: HOST, headers: fwd })).status, 200, "the login page itself is public");
});

test("login: cookie is HttpOnly, SameSite=Strict, Secure behind https; wrong password is 401", async () => {
  assert.equal((await login("198.51.100.1", "nope nope nope nope")).status, 401);
  const r = await login();
  assert.equal(r.status, 200);
  const c = String(r.headers["set-cookie"]);
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/); assert.match(c, /Secure/); assert.match(c, /Max-Age=28800/);
});

let cookie = "";
test("a logged-in remote user can read everything but writes need the CSRF header", async () => {
  cookie = "hl_session=" + cookieOf(String((await login()).headers["set-cookie"]), "hl_session");
  const h = { ...fwd, cookie };
  const s = await req("GET", "/api/summary", { host: HOST, headers: h });
  assert.equal(s.status, 200);
  assert.equal(s.json.verify.ok, true);
  assert.equal((await req("GET", "/api/contracts", { host: HOST, headers: h })).status, 200);
  // a cross-site form post would carry the cookie but not the custom header
  assert.equal((await req("POST", "/api/dispatch", { host: HOST, headers: h, body: { task: "x" } })).status, 403);
});

test("remote dispatch is queued as PENDING; the editor AI cannot take it until approved on this computer", async () => {
  const h = { ...fwd, cookie, "x-handoff": "1" };
  const d = await req("POST", "/api/dispatch", { host: HOST, headers: h, body: { task: "add rate limiting to /login", contract: "login-limit" } });
  assert.equal(d.status, 200);
  assert.equal(d.json.status, "pending-approval");
  assert.match(d.json.prompt, /GOAL: add rate limiting/);
  assert.match(d.json.prompt, /Never modify the production database/);
  // remote cannot approve its own task
  assert.equal((await req("POST", "/api/queue/approve", { host: HOST, headers: h, body: { id: d.json.id } })).status, 403);
  assert.equal((await req("GET", "/api/queue", { host: HOST, headers: h })).json.at(-1).status, "pending-approval");
  // local approval works with the token
  assert.equal((await local("POST", "/api/queue/approve", { id: d.json.id })).status, 200);
  assert.equal((await local("GET", "/api/queue")).json.at(-1).status, "approved");
});

test("remote cannot loosen control or forge history: undo, switch, wake/sleep, events, consolidate are local-only", async () => {
  const h = { ...fwd, cookie, "x-handoff": "1" };
  for (const [p, b] of [["/api/reverse", { id: "x" }], ["/api/switch", { to: "codex", write: true }], ["/api/providers/wake", { name: "claude", role: "steward" }], ["/api/providers/sleep", { name: "claude" }], ["/api/events", { actor: { kind: "human", name: "me" }, action: "decision", summary: "forged" }], ["/api/consolidate", {}], ["/api/queue/finish", { id: "x" }]] as const)
    assert.equal((await req("POST", p, { host: HOST, headers: h, body: b })).status, 403, p);
  assert.ok(!new Ledger(lp).all().some((e) => e.summary === "forged"));
});

test("remote may TIGHTEN: add a guardrail and open a contract", async () => {
  const h = { ...fwd, cookie, "x-handoff": "1" };
  assert.equal((await req("POST", "/api/guardrails", { host: HOST, headers: h, body: { text: "No sudo", match: { kind: "command", pattern: "^sudo\\b" } } })).status, 200);
  assert.equal((await req("POST", "/api/contracts", { host: HOST, headers: h, body: { id: "from-phone", goal: "g" } })).status, 200);
});

test("logout kills the session", async () => {
  const c2 = "hl_session=" + cookieOf(String((await login()).headers["set-cookie"]), "hl_session");
  const h = { ...fwd, cookie: c2, "x-handoff": "1" };
  assert.equal((await req("GET", "/api/summary", { host: HOST, headers: h })).status, 200);
  await req("POST", "/api/logout", { host: HOST, headers: h, body: {} });
  assert.equal((await req("GET", "/api/summary", { host: HOST, headers: h })).status, 401);
});

test("local: wake/sleep AIs through the API enforces the two-awake rule and audits it in the ledger", async () => {
  assert.equal((await local("POST", "/api/providers/wake", { name: "claude", role: "steward" })).status, 200);
  assert.equal((await local("POST", "/api/providers/wake", { name: "llama", role: "editor" })).status, 200);
  const st = (await local("GET", "/api/providers")).json;
  assert.deepEqual(st.providers.map((p: any) => [p.name, p.role]), [["claude", "steward"], ["llama", "editor"]]);
  assert.equal((await local("POST", "/api/providers/wake", { name: "ghost", role: "editor" })).status, 400);
  assert.equal((await local("POST", "/api/providers/wake", { name: "claude", role: "boss" })).status, 400);
  const acts = new Ledger(lp).all().map((e) => e.action);
  assert.ok(acts.filter((a) => a === "provider.wake").length >= 2);
  // with a steward awake the dispatch prompt is LLM-compressed through the registry (fake server) and usage is counted
  const d = (await local("POST", "/api/dispatch", { task: "fix the login auth bug where session cookies expire" })).json;
  assert.equal(d.via, "llm", String(d.why));
  assert.equal(d.status, "approved", "local dispatch needs no extra approval");
  assert.ok(new Registry({ home }).usedToday() > 0);
});

test("brute force: 5 wrong passwords lock that IP (even for the right password); other IPs still work until the global cap", async () => {
  const ip = "192.0.2.77";
  for (let i = 0; i < 5; i++) assert.equal((await login(ip, "wrong wrong wrong!")).status, 401);
  const locked = await login(ip, PASSWORD);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers["retry-after"]) > 0);
  assert.equal((await login("192.0.2.78")).status, 200);
});

test("throttle and session units: windows expire, sessions expire and cap", () => {
  let t = 0;
  const th = makeThrottle(() => t, 1000, 2, 3);
  th.fail("a"); th.fail("a");
  assert.equal(th.check("a").ok, false);
  t = 1500; assert.equal(th.check("a").ok, true, "window passed");
  th.fail("a"); th.fail("b"); th.fail("c");
  assert.equal(th.check("zzz").ok, false, "global cap locks everyone");
  let now = 0;
  const s = new Sessions(() => now, 1000, 2);
  const a = s.create(), b = s.create(), c = s.create();
  assert.equal(s.valid(a), false, "oldest evicted at the cap");
  assert.ok(s.valid(b) && s.valid(c));
  now = 2000; assert.equal(s.valid(b), false);
  assert.equal(s.valid(undefined), false);
});

test("local token paths are unchanged: still works without a password and without cookies", async () => {
  assert.equal((await local("GET", "/api/summary")).status, 200);
  assert.equal((await req("GET", "/api/summary")).status, 401);
});

test("global guardrails reach the server's own brief for steward prompts", async () => {
  addGlobalGuardrail(home, "block", "Never touch billing config", { kind: "path", pattern: "billing/**" });
  const d = (await local("POST", "/api/dispatch", { task: "update the invoice docs" })).json;
  assert.match(d.prompt, /Never touch billing config/);
});
