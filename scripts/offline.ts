// Offline test of every method on the real model probabilities collected by collect.ts.
// Ground truth per option = a Monte Carlo oracle (deep rollouts, cached), so no new model calls are needed.
// Each method only steps in when the model's confidence is below the gate threshold.
// Usage: node scripts/offline.ts <model> [thresholds...]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { placements, mulberry32, PIECES, type Board, type PieceName, type Placement } from "../lib/tetris.ts";
import { METHODS, argmax, boardFeatures, choose, feats, type Input } from "../lib/heuristics.ts";

const model = process.argv[2] ?? "clef-flash";
const gates = process.argv.slice(3).map(Number);
const GATES = gates.length ? gates : [0.05, 0.1, 0.15, 0.25, 1];
const rows = readFileSync(`experiments/data/moves-${model}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)) as {
  board: Board; piece: PieceName; next: PieceName; options: { rot: number; col: number }[]; probs: number[]; confidence: number;
}[];

// Oracle: 12 rollouts x depth 8, greedy lookahead-free Dellacherie policy, survival-style leaf value.
// ponytail: the policy is Dellacherie, so the oracle leans toward Dellacherie-like play; live games are the unbiased check.
function oracleValue(p: Placement, next: PieceName, seed: number): number {
  const rng = mulberry32(seed);
  let total = 0;
  for (let r = 0; r < 12; r++) {
    let board = p.board, lines = p.lines, dead = false;
    for (let d = 0; d < 8; d++) {
      const piece = d === 0 ? next : PIECES[Math.floor(rng() * 7)];
      const ps = placements(board, piece);
      if (!ps.length) { dead = true; break; }
      const q = ps[choose("dellacherie", { prev: board, piece, options: ps })];
      board = q.board; lines += q.lines;
    }
    const f = boardFeatures(board);
    total += dead ? -500 : 10 * lines - 8 * f.holes - 2 * f.maxHeight - 0.3 * f.aggHeight - 0.5 * f.bumpiness;
  }
  return total / 12;
}

const cachePath = `experiments/data/oracle-${model}.json`;
const cache: number[][] = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : [];
const states = rows.map((r, i) => {
  const all = placements(r.board, r.piece);
  const options = r.options.map((o) => all.find((p) => p.rot === o.rot && p.col === o.col)!);
  if (!cache[i]) cache[i] = options.map((p, k) => oracleValue(p, r.next, i * 1000 + k));
  const input: Input = { prev: r.board, piece: r.piece, next: r.next, options, probs: r.probs };
  return { input, oracle: cache[i], conf: r.confidence };
});
writeFileSync(cachePath, JSON.stringify(cache));

const regret = (s: (typeof states)[0], i: number) => Math.max(...s.oracle) - s.oracle[i];
const holeBlunder = (s: (typeof states)[0], i: number) => {
  const f = feats(s.input);
  return f[i].newHoles > 0 && f.some((x) => x.newHoles <= 0);
};

const confs = states.map((s) => s.conf).sort((a, b) => a - b);
console.log(`${model}: ${states.length} states, confidence median ${confs[Math.floor(confs.length / 2)].toFixed(3)}, p90 ${confs[Math.floor(confs.length * 0.9)].toFixed(3)}`);

const results: Record<string, Record<string, { regret: number; best: number; blunders: number; assisted: number }>> = {};
const evaluate = (pick: (s: (typeof states)[0]) => number, gate: number) => {
  let rg = 0, best = 0, bl = 0, assisted = 0;
  for (const s of states) {
    const useMethod = s.conf < gate;
    if (useMethod) assisted++;
    const i = useMethod ? pick(s) : argmax(s.input.probs!);
    rg += regret(s, i); if (s.oracle[i] === Math.max(...s.oracle)) best++; if (holeBlunder(s, i)) bl++;
  }
  const n = states.length;
  return { regret: rg / n, best: best / n, blunders: bl / n, assisted: assisted / n };
};

const base = evaluate((s) => argmax(s.input.probs!), 0);
results["model-only"] = { all: base };
console.log(`${"model-only".padEnd(16)} regret ${base.regret.toFixed(2).padStart(6)}  oracle-best ${(base.best * 100).toFixed(0).padStart(3)}%  hole-blunders ${(base.blunders * 100).toFixed(0).padStart(3)}%`);
for (const m of METHODS) {
  results[m.id] = {};
  const line = GATES.map((g) => {
    const r = evaluate((s) => choose(m.id, s.input), g);
    results[m.id][String(g)] = r;
    return `<${g}: ${r.regret.toFixed(2).padStart(6)} ${(r.best * 100).toFixed(0).padStart(3)}% ${(r.blunders * 100).toFixed(0).padStart(3)}%`;
  }).join(" | ");
  console.log(`${m.id.padEnd(16)} ${line}`);
}
console.log(`columns per gate: regret (lower better), % oracle-best pick, % hole blunders; assisted share at each gate: ` +
  GATES.map((g) => `${g}=${(states.filter((s) => s.conf < g).length / states.length * 100).toFixed(0)}%`).join(" "));
// Does the model carry signal? Mean Spearman correlation between its probabilities and the oracle, per state.
const ranks = (xs: number[]) => { const o = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]); const r = Array(xs.length); o.forEach((i, k) => (r[i] = k)); return r as number[]; };
const pearson = (a: number[], b: number[]) => {
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  const num = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0);
  const den = Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * b.reduce((s, x) => s + (x - mb) ** 2, 0));
  return den ? num / den : 0;
};
const rho = states.reduce((s, st) => s + pearson(ranks(st.input.probs!), ranks(st.oracle)), 0) / states.length;
const rhoLook = states.reduce((s, st) => s + pearson(ranks(METHODS.find((m) => m.id === "lookahead")!.scores(st.input)), ranks(st.oracle)), 0) / states.length;
console.log(`signal: Spearman(model probs, oracle) = ${rho.toFixed(3)}; Spearman(lookahead, oracle) = ${rhoLook.toFixed(3)}`);

// Beta search for poe-tuned: log p + beta * z(lookahead), always on.
const zs = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); return xs.map((x) => (sd ? (x - m) / sd : 0)); };
const look = states.map((s) => zs(METHODS.find((m) => m.id === "lookahead")!.scores(s.input)));
const betas = [0.25, 0.5, 1, 2, 3, 5, 8, 13, 21];
const betaRes = betas.map((b) => {
  const r = evaluate((s) => { const i = states.indexOf(s); return argmax(s.input.probs!.map((x, k) => Math.log(x + 1e-6) + b * look[i][k])); }, 2);
  return { beta: b, ...r };
});
console.log("poe beta search: " + betaRes.map((r) => `b=${r.beta}: ${r.regret.toFixed(2)}`).join("  "));
const bestBeta = betaRes.reduce((a, b) => (b.regret < a.regret ? b : a)).beta;
console.log(`best beta ${bestBeta}`);
writeFileSync(`experiments/offline-${model}.json`, JSON.stringify({ model, n: states.length, gates: GATES, results, signal: { modelRho: rho, lookaheadRho: rhoLook }, betaSearch: betaRes, bestBeta }, null, 2));
