// Stage the compiled core inside extension/, so the extension is self-contained.
//
// Node rather than shell because this runs as a `pretest` on Windows CI too, where a bash script is
// not a given. build-ext.sh calls this, so there is one definition of what staging means.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const core = join(root, "extension", "core");
const hookDir = join(root, "extension", "hook");

if (!existsSync(join(dist, "ledger.js"))) {
  console.error("stage-extension: dist/ is not built. Run `tsc -p .` first (npm test does).");
  process.exit(1);
}

rmSync(core, { recursive: true, force: true });
rmSync(hookDir, { recursive: true, force: true });

cpSync(dist, core, { recursive: true });
// The core is ESM; without this Node treats the .js files as CommonJS and the imports fail.
writeFileSync(join(core, "package.json"), '{"type":"module"}\n');

mkdirSync(hookDir, { recursive: true });
cpSync(join(root, "hooks", "claude-code-hook.mjs"), join(hookDir, "claude-code-hook.mjs"));

console.log("staged extension/core and extension/hook");
