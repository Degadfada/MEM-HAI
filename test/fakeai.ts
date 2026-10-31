import http from "node:http";

/** A fake server that speaks the real wire formats of Anthropic, Gemini and Ollama, and records what it received. */
export interface Seen { path: string; headers: http.IncomingHttpHeaders; body: any }
export async function fakeAi(reply: (prompt: string, system: string | undefined, path: string) => string = (p) => `echo: ${p.slice(0, 40)}`) {
  const seen: Seen[] = [];
  let fail: number | null = null;
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      seen.push({ path: req.url!, headers: req.headers, body });
      if (fail) { res.writeHead(fail); res.end(JSON.stringify({ error: "boom sk-secret-key-123" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/messages") {
        const prompt = body.messages[0].content;
        res.end(JSON.stringify({ content: [{ type: "text", text: reply(prompt, body.system, req.url!) }], usage: { input_tokens: 100, output_tokens: 50 } }));
      } else if (req.url!.includes(":generateContent")) {
        const prompt = body.contents[0].parts[0].text;
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: reply(prompt, body.systemInstruction?.parts?.[0]?.text, req.url!) }] } }], usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 40 } }));
      } else if (req.url === "/api/chat") {
        const prompt = body.messages.at(-1).content;
        res.end(JSON.stringify({ message: { role: "assistant", content: reply(prompt, body.messages[0]?.role === "system" ? body.messages[0].content : undefined, req.url!) }, prompt_eval_count: 60, eval_count: 30 }));
      } else { res.writeHead(404); res.end("{}"); }
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  return { url, seen, failWith: (c: number | null) => (fail = c), close: () => new Promise<void>((ok) => server.close(() => ok())) };
}
