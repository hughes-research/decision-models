// Learns heuristic weights from the model's own judgments and writes lib/learned.ts.
//   health: ridge regression of clef's 0-4 board ratings on board features
//   move:   softmax regression matching the models' move-probability distributions
// Usage: node scripts/fit.ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { placements, type Board, type PieceName } from "../lib/tetris.ts";
import { BOARD_KEYS, boardFeatures, placementFeatures, type F } from "../lib/heuristics.ts";
import { LEARNED } from "../lib/learned.ts";

const readJsonl = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// Solve (A + lambda I) x = b by Gaussian elimination.
function solve(A: number[][], b: number[], lambda = 1e-3): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r.map((v, j) => v + (i === j ? lambda : 0)), b[i]]);
  for (let c = 0; c < n; c++) {
    const p = M.slice(c).reduce((bi, r, i) => (Math.abs(r[c]) > Math.abs(M[bi][c]) ? i + c : bi), c);
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) {
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

const stats = (cols: number[][]) => cols.map((c) => {
  const m = c.reduce((a, b) => a + b, 0) / c.length;
  return { m, sd: Math.sqrt(c.reduce((a, b) => a + (b - m) ** 2, 0) / c.length) || 1 };
});

// ---- health distillation ----
const health = readJsonl("experiments/data/health.jsonl") as { board: Board; score: number }[];
let healthW = LEARNED.health, healthBias = LEARNED.healthBias, healthReport = "no data";
if (health.length >= 20) {
  const X = health.map((h) => { const f = boardFeatures(h.board); return BOARD_KEYS.map((k) => f[k]); });
  const y = health.map((h) => h.score);
  const st = stats(BOARD_KEYS.map((_, j) => X.map((r) => r[j])));
  const Z = X.map((r) => [1, ...r.map((v, j) => (v - st[j].m) / st[j].sd)]);
  const A = Z[0].map((_, i) => Z[0].map((_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0)));
  const b = Z[0].map((_, i) => Z.reduce((s, r, n) => s + r[i] * y[n], 0));
  const w = solve(A, b, 1);
  const pred = Z.map((r) => r.reduce((s, v, i) => s + v * w[i], 0));
  const ym = y.reduce((a, b) => a + b, 0) / y.length;
  const r2 = 1 - pred.reduce((s, p, i) => s + (y[i] - p) ** 2, 0) / y.reduce((s, v) => s + (v - ym) ** 2, 0);
  healthW = Object.fromEntries(BOARD_KEYS.map((k, j) => [k, w[j + 1] / st[j].sd])) as typeof healthW;
  healthBias = w[0] - BOARD_KEYS.reduce((s, _, j) => s + (w[j + 1] * st[j].m) / st[j].sd, 0);
  healthReport = `n=${health.length} R^2=${r2.toFixed(3)} standardized: ` + BOARD_KEYS.map((k, j) => `${k} ${w[j + 1].toFixed(3)}`).join(", ");
}
console.log("health:", healthReport);

// ---- move distillation (softmax regression) ----
type MoveRow = { board: Board; piece: PieceName; options: { rot: number; col: number }[]; probs: number[] };
const moveRows = [...readJsonl("experiments/data/moves-clef-flash.jsonl"), ...readJsonl("experiments/data/moves-clef.jsonl")] as MoveRow[];
const MOVE_KEYS = [...BOARD_KEYS, "lines"] as const;
let moveW = LEARNED.move, moveLines = LEARNED.moveLines, moveReport = "no data";
if (moveRows.length >= 20) {
  const states = moveRows.map((r) => {
    const ps = placements(r.board, r.piece);
    const ph = boardFeatures(r.board).holes;
    const fs = r.options.map((o) => placementFeatures(r.board, ph, r.piece, ps.find((p) => p.rot === o.rot && p.col === o.col)!));
    const tot = r.probs.reduce((a, b) => a + b, 0) || 1;
    return { x: fs.map((f: F) => MOVE_KEYS.map((k) => f[k])), p: r.probs.map((v) => v / tot) };
  });
  const st = stats(MOVE_KEYS.map((_, j) => states.flatMap((s) => s.x.map((r) => r[j]))));
  const Zs = states.map((s) => ({ x: s.x.map((r) => r.map((v, j) => (v - st[j].m) / st[j].sd)), p: s.p }));
  const w = Array(MOVE_KEYS.length).fill(0);
  const loss = () => Zs.reduce((L, s) => {
    const u = s.x.map((r) => r.reduce((a, v, j) => a + v * w[j], 0));
    const mx = Math.max(...u), lse = mx + Math.log(u.reduce((a, v) => a + Math.exp(v - mx), 0));
    return L - s.p.reduce((a, pi, i) => a + pi * (u[i] - lse), 0);
  }, 0) / Zs.length;
  for (let it = 0; it < 3000; it++) {
    const g = Array(w.length).fill(0);
    for (const s of Zs) {
      const u = s.x.map((r) => r.reduce((a, v, j) => a + v * w[j], 0));
      const mx = Math.max(...u), e = u.map((v) => Math.exp(v - mx)), tot = e.reduce((a, b) => a + b, 0);
      s.x.forEach((r, i) => r.forEach((v, j) => (g[j] += (e[i] / tot - s.p[i]) * v)));
    }
    g.forEach((gj, j) => (w[j] -= (0.5 * gj) / Zs.length + 1e-3 * w[j]));
  }
  const uniform = Zs.reduce((L, s) => L + Math.log(s.x.length), 0) / Zs.length;
  const agree = Zs.filter((s) => {
    const u = s.x.map((r) => r.reduce((a, v, j) => a + v * w[j], 0));
    return u.indexOf(Math.max(...u)) === s.p.indexOf(Math.max(...s.p));
  }).length / Zs.length;
  const raw = MOVE_KEYS.map((_, j) => w[j] / st[j].sd);
  moveW = Object.fromEntries(BOARD_KEYS.map((k, j) => [k, raw[j]])) as typeof moveW;
  moveLines = raw[MOVE_KEYS.length - 1];
  moveReport = `n=${Zs.length} cross-entropy ${loss().toFixed(3)} (uniform ${uniform.toFixed(3)}), top-1 agreement with model ${(agree * 100).toFixed(0)}%; standardized: ` + MOVE_KEYS.map((k, j) => `${k} ${w[j].toFixed(3)}`).join(", ");
}
console.log("move:", moveReport);

const poeBeta = Number(process.env.POE_BETA ?? LEARNED.poeBeta);
// Source reliabilities for reliability-rank, measured by scripts/offline.ts (Spearman vs the oracle).
const off = existsSync("experiments/offline-clef-flash.json") ? JSON.parse(readFileSync("experiments/offline-clef-flash.json", "utf8")).signal : null;
const rhoModel = Number((off?.modelRho ?? LEARNED.rhoModel ?? 0.44).toFixed(3)), rhoLookahead = Number((off?.lookaheadRho ?? LEARNED.rhoLookahead ?? 0.69).toFixed(3));
const r6 = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v.toFixed(6))]));
writeFileSync("lib/learned.ts", `// Generated by scripts/fit.ts from the model's own judgments. Do not edit by hand.
// health: ${healthReport}
// move: ${moveReport}
export const LEARNED = ${JSON.stringify({ health: r6(healthW), healthBias: Number(healthBias.toFixed(6)), move: r6(moveW), moveLines: Number(moveLines.toFixed(6)), poeBeta, rhoModel, rhoLookahead }, null, 2)};
`);
console.log("wrote lib/learned.ts");
