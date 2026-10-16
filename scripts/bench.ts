// Heuristic-only benchmark: every method plays the same seeds with no model in the loop.
// Fusion methods see a flat (uniform) model distribution, so this measures their heuristic side only.
// Usage: node scripts/bench.ts [seeds=5] [maxPieces=500] [ids...]
import { writeFileSync, mkdirSync } from "node:fs";
import { emptyBoard, makeBag, placements, LINE_SCORE } from "../lib/tetris.ts";
import { METHODS, choose, boardFeatures } from "../lib/heuristics.ts";

const [seedsArg, capArg, ...ids] = process.argv.slice(2);
const SEEDS = Number(seedsArg ?? 5), CAP = Number(capArg ?? 500);
const methods = ids.length ? METHODS.filter((m) => ids.includes(m.id)) : METHODS;

export function play(id: string, seed: number, cap: number) {
  const bag = makeBag(seed);
  let board = emptyBoard(), piece = bag(), next = bag();
  let pieces = 0, lines = 0, score = 0, holeSum = 0, heightSum = 0, tetrises = 0;
  while (pieces < cap) {
    const options = placements(board, piece);
    if (!options.length) break;
    const p = options[choose(id, { prev: board, piece, next, options })];
    board = p.board; lines += p.lines; score += LINE_SCORE[p.lines]; if (p.lines === 4) tetrises++;
    const f = boardFeatures(board);
    holeSum += f.holes; heightSum += f.maxHeight;
    pieces++; piece = next; next = bag();
  }
  return { pieces, lines, score, tetrises, survived: pieces >= cap, avgHoles: holeSum / pieces, avgHeight: heightSum / pieces };
}

const rows = [];
for (const m of methods) {
  const t = performance.now();
  const games = Array.from({ length: SEEDS }, (_, i) => play(m.id, i + 1, CAP));
  const mean = (k: keyof (typeof games)[0]) => games.reduce((s, g) => s + Number(g[k]), 0) / games.length;
  const row = {
    id: m.id, kind: m.kind,
    pieces: mean("pieces"), lines: mean("lines"), score: mean("score"), tetrises: mean("tetrises"),
    survived: games.filter((g) => g.survived).length, avgHoles: mean("avgHoles"), avgHeight: mean("avgHeight"),
    msPerMove: (performance.now() - t) / games.reduce((s, g) => s + g.pieces, 0),
  };
  rows.push(row);
  console.log(`${m.id.padEnd(16)} pieces ${row.pieces.toFixed(0).padStart(4)} lines ${row.lines.toFixed(0).padStart(4)} score ${row.score.toFixed(0).padStart(6)} tetrises ${row.tetrises.toFixed(1).padStart(4)} survived ${row.survived}/${SEEDS} holes ${row.avgHoles.toFixed(2)} height ${row.avgHeight.toFixed(1)} ${row.msPerMove.toFixed(1)}ms/move`);
}
mkdirSync("experiments", { recursive: true });
writeFileSync(`experiments/bench${ids.length ? "-" + ids.join("-") : ""}.json`, JSON.stringify({ seeds: SEEDS, cap: CAP, rows }, null, 2));
