// Collects the model's own judgments for the "learned" heuristics:
//   health.jsonl     clef rates sampled boards 0-4 (board-health distillation)
//   moves-<m>.jsonl  each model's move probabilities on sampled states (move distillation + offline fusion tests)
// Usage: node scripts/collect.ts [healthN] [flashMovesN] [clefMovesN]
import { appendFileSync, mkdirSync } from "node:fs";
import { emptyBoard, makeBag, mulberry32, placements, toOptions, toAscii, shuffle, type Board, type PieceName } from "../lib/tetris.ts";
import { choose } from "../lib/heuristics.ts";
import { moveRequest } from "../lib/prompt.ts";

const OLLAMA = (process.env.OLLAMA_URL ?? "http://localhost:11434") + "/v1/systemone";
const DIR = "experiments/data";
mkdirSync(DIR, { recursive: true });
const [healthN, flashN, clefN] = process.argv.slice(2).map(Number);

type State = { board: Board; piece: PieceName; next: PieceName };

// Epsilon-noisy Dellacherie play gives boards from tidy (eps 0.1) to messy (eps 0.6).
export function sampleStates(n: number, seed0 = 1000): State[] {
  const out: State[] = [];
  for (let seed = seed0; out.length < n * 3; seed++) {
    const bag = makeBag(seed), rng = mulberry32(seed * 7 + 1), eps = [0.1, 0.3, 0.6][seed % 3];
    let board = emptyBoard(), piece = bag(), next = bag();
    for (let t = 0; t < 150; t++) {
      const ps = placements(board, piece);
      if (!ps.length) break;
      if (t % 5 === 4) out.push({ board, piece, next });
      const i = rng() < eps ? Math.floor(rng() * ps.length) : choose("dellacherie", { prev: board, piece, next, options: ps });
      board = ps[i].board; piece = next; next = bag();
    }
  }
  return shuffle(out, mulberry32(seed0)).slice(0, n);
}

async function ask(body: unknown) {
  const t = performance.now();
  const r = await fetch(OLLAMA, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return { answers: d.answers, ms: performance.now() - t };
}

async function health(n: number) {
  const states = sampleStates(n, 5000);
  for (const [i, s] of states.entries()) {
    const { answers, ms } = await ask({
      model: "clef", keep_alive: "30m",
      state: { board: toAscii(s.board), legend: "10 wide x 20 tall, top row first. '#' = filled, '.' = empty.", request_id: crypto.randomUUID() },
      questions: { health: { type: "score", instructions: "How healthy is this Tetris board for surviving a long game? Consider holes, stack height and surface shape.", criteria: ["terrible", "poor", "okay", "good", "excellent"] } },
    });
    appendFileSync(`${DIR}/health.jsonl`, JSON.stringify({ board: s.board, score: answers.health.score, probs: answers.health.probabilities }) + "\n");
    if (i % 10 === 0) console.log(`health ${i + 1}/${n} score ${answers.health.score.toFixed(2)} ${Math.round(ms)}ms`);
  }
}

async function moves(model: string, n: number) {
  const states = sampleStates(n, model === "clef" ? 9000 : 7000);
  const rng = mulberry32(77);
  for (const [i, s] of states.entries()) {
    const ps = placements(s.board, s.piece);
    if (ps.length < 2) continue;
    const opts = toOptions(ps, rng);
    const { answers, ms } = await ask(moveRequest(model, toAscii(s.board), s.piece, opts.map(({ letter, text }) => ({ letter, text }))));
    const m = answers.move;
    appendFileSync(`${DIR}/moves-${model}.jsonl`, JSON.stringify({
      ...s, options: opts.map((o) => ({ rot: o.rot, col: o.col, letter: o.letter })),
      probs: opts.map((o) => m.probabilities[o.letter] ?? 0), confidence: m.confidence, ms,
    }) + "\n");
    if (i % 10 === 0) console.log(`moves ${model} ${i + 1}/${n} conf ${m.confidence.toFixed(3)} ${Math.round(ms)}ms`);
  }
}

if (healthN) await health(healthN);
if (flashN) await moves("clef-flash", flashN);
if (clefN) await moves("clef", clefN);
console.log("collect done");
