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
  const res = await fetch(`${OLLAMA_URL}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(moveRequest(model, board, piece, options)),
  });
  const ms = performance.now() - t;
  const data = await res.json();
  if (!res.ok) return Response.json({ error: data.error ?? `ollama ${res.status}` }, { status: 502 });

  const m = data.answers.move;
  return Response.json({ letter: m.choice, probabilities: m.probabilities, confidence: m.confidence, ms });
}
