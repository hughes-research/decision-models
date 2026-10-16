// Live games with the model in the loop: the model decides every move, and the method takes over
// only when the model's confidence is below the gate. Same seed = same pieces for every config.
// Usage: node scripts/live.ts <model> <pieces> <seed> <method|off>[@gate] ...
//   e.g. node scripts/live.ts clef-flash 60 3 off lookahead@0.15 poe@1
import { appendFileSync, mkdirSync } from "node:fs";
import { emptyBoard, makeBag, mulberry32, placements, toOptions, toAscii, LINE_SCORE } from "../lib/tetris.ts";
import { argmax, boardFeatures, choose } from "../lib/heuristics.ts";
import { moveRequest } from "../lib/prompt.ts";

const OLLAMA = (process.env.OLLAMA_URL ?? "http://localhost:11434") + "/v1/systemone";
const [model, piecesArg, seedArg, ...configs] = process.argv.slice(2);
const CAP = Number(piecesArg), SEED = Number(seedArg);
mkdirSync("experiments", { recursive: true });

for (const cfg of configs) {
  const [id, gateStr] = cfg.split("@");
  const gate = id === "off" ? 0 : Number(gateStr ?? 0.15);
  const bag = makeBag(SEED), rng = mulberry32(SEED ^ 0x9e3779b9);
  let board = emptyBoard(), piece = bag(), next = bag();
  let pieces = 0, lines = 0, score = 0, assisted = 0, overrides = 0, confSum = 0;
  const t0 = performance.now();
  while (pieces < CAP) {
    const ps = placements(board, piece);
    if (!ps.length) break;
    let p = ps[0];
    if (ps.length > 1) {
      const opts = toOptions(ps, rng);
      const r = await fetch(OLLAMA, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(moveRequest(model, toAscii(board), piece, opts.map(({ letter, text }) => ({ letter, text })))) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      const m = d.answers.move;
      const probs = opts.map((o) => m.probabilities[o.letter] ?? 0);
      confSum += m.confidence;
      let k = argmax(probs);
      if (m.confidence < gate) {
        assisted++;
        const h = choose(id, { prev: board, piece, next, options: opts, probs });
        if (h !== k) overrides++;
        k = h;
      }
      p = opts[k];
    }
    board = p.board; lines += p.lines; score += LINE_SCORE[p.lines];
    pieces++; piece = next; next = bag();
  }
  const f = boardFeatures(board);
  const row = { model, config: cfg, seed: SEED, cap: CAP, pieces, toppedOut: pieces < CAP, lines, score, holes: f.holes, maxHeight: f.maxHeight,
    assisted, overrides, avgConf: confSum / Math.max(1, pieces), minutes: (performance.now() - t0) / 60000 };
  appendFileSync("experiments/live.jsonl", JSON.stringify(row) + "\n");
  console.log(`${cfg.padEnd(22)} pieces ${String(pieces).padStart(3)}${row.toppedOut ? " (topped out)" : ""} lines ${String(lines).padStart(3)} score ${String(score).padStart(5)} holes ${String(f.holes).padStart(2)} height ${String(f.maxHeight).padStart(2)} assisted ${assisted} overrides ${overrides} ${row.minutes.toFixed(1)}min`);
}
