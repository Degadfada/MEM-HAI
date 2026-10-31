import { createHash } from "node:crypto";

// Deterministic JSON: sorted keys, no whitespace. Same logical record => same bytes => same hash.
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
