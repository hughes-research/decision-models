// Proxies a move decision to Ollama's decision-model endpoint (server-side, so no CORS).
import { moveRequest, type Opt } from "@/lib/prompt";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODELS = new Set(["clef", "clef-flash"]);

type Body = { model: string; board: string; piece: string; options: Opt[] };

export async function POST(req: Request) {
  const { model, board, piece, options } = (await req.json()) as Body;
  if (!MODELS.has(model) || !Array.isArray(options) || options.length < 2 || options.length > 26) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const t = performance.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(moveRequest(model, board, piece, options)),
      signal: req.signal, // a piece that locked first aborts its request, so Ollama doesn't queue stale work
    });
    const ms = performance.now() - t;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return Response.json({ error: `ollama ${res.status}: ${data.error ?? res.statusText}` }, { status: 502 });
    const m = data.answers?.move;
    if (!m) return Response.json({ error: "ollama returned no move answer" }, { status: 502 });
    return Response.json({ letter: m.choice, probabilities: m.probabilities, confidence: m.confidence, ms });
  } catch (e) {
    if (req.signal.aborted) return new Response(null, { status: 499 }); // the client gave up; nothing to report
    return Response.json({ error: `ollama unreachable at ${OLLAMA_URL}: ${(e as Error).message}` }, { status: 502 });
  }
}
