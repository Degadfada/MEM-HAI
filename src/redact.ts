// Secret redaction. Runs BEFORE anything is written: the ledger never holds a raw secret.
// Sampling cannot certify rare catastrophic items, so this is a full scan of every string.

const PATTERNS: Array<[string, RegExp]> = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["aws-access-key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["openai-style-key", /\bsk-[A-Za-z0-9]{32,}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ["url-credentials", /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi],
  [
    "assignment",
    /\b((?:[A-Za-z0-9_]*)(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"']{6,})\3/gi,
  ],
];

export interface RedactionResult<T> {
  value: T;
  count: number;
  kinds: string[];
}

export function redactString(s: string): { text: string; count: number; kinds: Set<string> } {
  let count = 0;
  const kinds = new Set<string>();
  let text = s;
  for (const [kind, re] of PATTERNS) {
    text = text.replace(re, (...m) => {
      count++;
      kinds.add(kind);
      if (kind === "url-credentials") return `${m[1]}[REDACTED:${kind}]@`;
      if (kind === "assignment") return `${m[1]}${m[2]}${m[3]}[REDACTED:${kind}]${m[3]}`;
      return `[REDACTED:${kind}]`;
    });
  }
  return { text, count, kinds };
}

const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;

export function redactDeep<T>(input: T): RedactionResult<T> {
  let count = 0;
  const kinds = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactString(v);
      count += r.count;
      r.kinds.forEach((k) => kinds.add(k));
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        // A secret stored under a telling key name ({DB_PASSWORD: "..."}) has no pattern in the value itself.
        if (typeof val === "string" && val.length >= 6 && SENSITIVE_KEY.test(k)) {
          count++;
          kinds.add("sensitive-key");
          out[k] = "[REDACTED:sensitive-key]";
        } else out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return { value: walk(input) as T, count, kinds: [...kinds].sort() };
}
