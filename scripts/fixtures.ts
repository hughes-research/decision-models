// Exports the TS rules to the Python OR solver so there is one source of truth:
//   or-solver/orsolver/tables.json        shapes, kicks, spawn, move order, scoring, gravity
//   or-solver/tests/fixtures/engine.json  reachable lock sets, features and points for parity tests
// Usage: node --no-warnings scripts/fixtures.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { W, H, PIECES, LINE_SCORE, GARBAGE, emptyBoard, placements, colHeights, mulberry32, type Board } from "../lib/tetris.ts";
import { SRS, KICKS_I, KICKS_JLSTZ, spawnState, reachable } from "../lib/srs.ts";
import { GRAVITY_MS, points } from "../lib/engine.ts";
import { boardFeatures } from "../lib/heuristics.ts";

const ROOT = "or-solver";
mkdirSync(`${ROOT}/orsolver`, { recursive: true });
mkdirSync(`${ROOT}/tests/fixtures`, { recursive: true });

writeFileSync(`${ROOT}/orsolver/tables.json`, JSON.stringify({
  W, H, garbage: GARBAGE,
  pieces: PIECES,
  srs: SRS,
  spawn: Object.fromEntries(PIECES.map((p) => [p, spawnState(p)])),
  kicks: { JLSTZ: KICKS_JLSTZ, I: KICKS_I }, // y points up, as published: apply (kx, -ky)
  moves: { advanced: ["cw", "ccw", "left", "right", "down"], basic: ["cw", "ccw", "left", "right"] },
  lineScore: LINE_SCORE,
  tspinPoints: { mini: [100, 200, 400, 400], full: [400, 800, 1200, 1600] },
  gravityMs: GRAVITY_MS,
}, null, 1));

const enc = (b: Board) => b.map((r) => r.map((c) => (c ? 1 : 0)).join(""));
// Compact board id for parity checks: each row as a 3-digit hex int with bit x = column x.
const hexBoard = (b: Board) => b.map((r) => r.reduce((m, c, x) => m | (c ? 1 << x : 0), 0).toString(16).padStart(3, "0")).join("");
const rows = (...lines: string[]): Board => {
  const b = emptyBoard();
  lines.forEach((l, i) => [...l].forEach((ch, x) => { if (ch === "X") b[H - lines.length + i][x] = 1; }));
  return b;
};

// Boards: empty, hand-made spin/tuck/well cases, and seeded random play (some with garbage-like rows).
const boards: { name: string; board: Board }[] = [
  { name: "empty", board: emptyBoard() },
  { name: "tsd", board: rows("XXXX......", "XXX...XXXX", "XXXX.XXXXX") },
  { name: "tst", board: rows("XXX.......", "XXX..XXXXX", "XXXX.XXXXX", "XXX.XXXXXX") },
  { name: "tuck", board: (() => { const b = emptyBoard(); b[H - 3][2] = 1; b[H - 3][3] = 1; return b; })() },
  { name: "well", board: rows("XXXXXXXXX.", "XXXXXXXXX.", "XXXXXXXXX.", "XXXXXXXXX.") },
];
const rng = mulberry32(2024);
let b = emptyBoard();
while (boards.length < 17) {
  const piece = PIECES[Math.floor(rng() * 7)];
  const ps = placements(b, piece);
  if (!ps.length || Math.max(...colHeights(b)) > 13) { b = emptyBoard(); continue; }
  b = ps[Math.floor(rng() * ps.length)].board;
  if (rng() < 0.15) { // a garbage row
    const gap = Math.floor(rng() * W);
    b = [...b.slice(1), Array.from({ length: W }, (_, x) => (x === gap ? 0 : GARBAGE))];
  }
  if (rng() < 0.12) boards.push({ name: `random${boards.length}`, board: b });
}

const cases = boards.flatMap(({ name, board }) => PIECES.flatMap((piece) => [false, true].map((advanced) => ({
  name, piece, advanced,
  locks: reachable(board, piece, spawnState(piece), advanced).map((p) => ({ board: hexBoard(p.board), spin: p.spin, lines: p.lines })),
}))));
const features = boards.map(({ name, board }) => {
  const f = boardFeatures(board);
  return { name, aggHeight: f.aggHeight, maxHeight: f.maxHeight, bumpiness: f.bumpiness, holes: f.holes, rowsWithHoles: f.rowsWithHoles, rowTrans: f.rowTrans, colTrans: f.colTrans, wells: f.wells, heights: f.heights };
});
const pts = [0, 1, 2, 3, 4].flatMap((lines) => (["none", "mini", "full"] as const).flatMap((spin) =>
  (spin === "mini" && lines > 2) || (spin === "full" && lines > 3) ? [] : [1, 3].map((level) => ({ lines, spin, level, points: points(lines, spin, level) }))));

writeFileSync(`${ROOT}/tests/fixtures/engine.json`, JSON.stringify({
  boards: Object.fromEntries(boards.map(({ name, board }) => [name, enc(board)])),
  cases, features, points: pts,
}));
console.log(`wrote tables.json and ${cases.length} reachability cases over ${boards.length} boards`);
