// Proxies a move decision to Ollama's decision-model endpoint (server-side, so no CORS).
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODELS = new Set(["clef", "clef-flash"]);

type Body = { model: string; board: string; piece: string; options: { letter: string; text: string }[] };

export async function POST(req: Request) {
  const { model, board, piece, options } = (await req.json()) as Body;
  if (!MODELS.has(model) || !Array.isArray(options) || options.length < 2 || options.length > 26) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const t = performance.now();
  const res = await fetch(`${OLLAMA_URL}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      keep_alive: "30m",
      state: {
        board,
        legend: "10 wide x 20 tall, top row first. '#' = filled, '.' = empty.",
        piece,
        goal: "Survive as long as possible and clear lines. Holes and tall stacks are bad.",
        request_id: crypto.randomUUID(), // replaying a seed would otherwise hit Ollama's cache and fake the timings
      },
      questions: {
        move: {
          type: "choice",
          instructions: `Where should the ${piece} piece be dropped for the best long-term Tetris play?`,
          criteria: Object.fromEntries(options.map((o) => [o.letter, o.text])),
        },
      },
    }),
  });
  const ms = performance.now() - t;
  const data = await res.json();
  if (!res.ok) return Response.json({ error: data.error ?? `ollama ${res.status}` }, { status: 502 });

  const m = data.answers.move;
  return Response.json({ letter: m.choice, probabilities: m.probabilities, confidence: m.confidence, ms });
}
