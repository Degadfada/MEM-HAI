import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "../src/ledger.ts";
import { tmpPath } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src", "ledger.ts");

/**
 * The hook, the extension host, the CLI and the dashboard all append to one file. Before the lock,
 * two appends in the same millisecond each claimed the same seq and prev, and the chain forked --
 * which silently destroyed the one guarantee the ledger exists to make.
 */
test("many processes appending at once keep the chain intact", () => {
  const path = tmpPath();
  new Ledger(path); // create the header first, so writers only append

  const writer = join(dirname(path), "writer.mjs");
  writeFileSync(
    writer,
    `import { Ledger } from ${JSON.stringify("file://" + SRC.split("\\").join("/"))};\n` +
      `const [who, file] = process.argv.slice(2);\n` +
      `const l = new Ledger(file);\n` +
      `for (let i = 0; i < 12; i++) l.append({ actor: { kind: "ai", name: who }, action: "file.edit", target: who + "-" + i });\n`,
  );

  const names = ["a", "b", "c", "d", "e", "f"];
  const procs = names.map((n) =>
    execFileSync(process.execPath, [writer, n, path], { encoding: "utf8", stdio: "pipe" }),
  );
  assert.equal(procs.length, names.length);

  const v = Ledger.verify(path);
  assert.equal(v.ok, true, `chain broken: ${v.error} at line ${v.atLine}`);
  assert.equal(v.events, names.length * 12, "no event was lost or overwritten");

  const events = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(1).map((l) => JSON.parse(l));
  assert.equal(new Set(events.map((e) => e.seq)).size, events.length, "every seq is unique");
  assert.equal(new Set(events.map((e) => e.id)).size, events.length, "every id is unique");
  for (const n of names)
    assert.equal(events.filter((e) => e.actor.name === n).length, 12, `${n} lost an append`);
});

test("a ledger forked by concurrent writers is detected, then repaired without losing an event", () => {
  const path = tmpPath();
  const l = new Ledger(path);
  const ai = { kind: "ai" as const, name: "copilot" };
  l.append({ actor: ai, action: "file.edit", target: "a.ts" });
  const second = l.append({ actor: ai, action: "file.edit", target: "b.ts" });

  // Forge the fork the old code produced: another event claiming the same position.
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const forked = { ...JSON.parse(lines[lines.length - 1]!), id: "ffffffffffffffff", target: "c.ts" };
  writeFileSync(path, lines.join("\n") + "\n" + JSON.stringify(forked) + "\n");

  const broken = Ledger.verify(path);
  assert.equal(broken.ok, false, "a fork must not pass verification");

  const r = Ledger.repair(path, { kind: "human", name: "idahosa" });
  assert.equal(r.ok, true, "repaired chain verifies");
  assert.equal(Ledger.verify(path).ok, true);

  const after = new Ledger(path).all();
  // 3 original events (one of them the forged duplicate position) + the repair record itself
  assert.equal(after.length, 4);
  assert.deepEqual(
    after.filter((e) => e.action === "file.edit").map((e) => e.target).sort(),
    ["a.ts", "b.ts", "c.ts"],
    "no event was dropped",
  );
  const rec = after.find((e) => e.action === "ledger.repair")!;
  assert.ok(rec, "the repair is itself in the record");
  assert.equal(rec.actor.name, "idahosa");
  assert.ok(String(rec.payload!.originalSha256).length === 64, "the original file is fingerprinted");

  // the untouched original is kept beside it
  assert.ok(readFileSync(r.backup, "utf8").includes("ffffffffffffffff"), "backup holds the pre-repair bytes");

  // Events before the break keep their hashes; the forged one is re-linked and so is re-hashed.
  assert.equal(after[1]!.hash, second.hash, "an event ahead of the break is untouched");
  const repaired = after.find((e) => e.target === "c.ts")!;
  assert.notEqual(repaired.hash, forked.hash, "the re-linked event is re-hashed");
  assert.equal(repaired.prev, second.hash, "it now points at the event it actually follows");
});

test("repair refuses to run on a healthy ledger", () => {
  const path = tmpPath();
  const l = new Ledger(path);
  l.append({ actor: { kind: "ai", name: "copilot" }, action: "file.edit", target: "a.ts" });
  assert.equal(Ledger.verify(path).ok, true);

  const out = execFileSync(process.execPath, [join(here, "..", "src", "cli.ts"), "repair", "--file", path], {
    encoding: "utf8",
  });
  assert.match(out, /nothing to repair/);
});
