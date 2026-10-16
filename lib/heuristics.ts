// Heuristic methods that help (or replace) the model's pick when it is undecided.
// Every method maps the current options to one score each; the highest score wins.
import { W, H, ROTATIONS, PIECES, placements, colHeights, holes as countHoles, mulberry32, type Board, type PieceName, type Placement } from "./tetris.ts";
import { LEARNED } from "./learned.ts";

// ---------- features ----------

export const BOARD_KEYS = ["aggHeight", "maxHeight", "bumpiness", "holes", "holeDepth", "rowsWithHoles", "rowTrans", "colTrans", "wells"] as const;
export type BoardKey = (typeof BOARD_KEYS)[number];
export type BoardF = Record<BoardKey, number> & { heights: number[]; well9: number };
export type F = BoardF & {
  landing: number; eroded: number; lines: number; contact: number; newHoles: number;
  // Lee's features are measured after the piece lands but before rows clear (as in his reference AI).
  leeAgg: number; leeHoles: number; leeBump: number;
};

const filled = (b: Board, x: number, y: number) => x < 0 || x >= W || y >= H || (y >= 0 && b[y][x] !== 0);

export function boardFeatures(b: Board): BoardF {
  const heights = colHeights(b);
  let rowTrans = 0, colTrans = 0, holes = 0, holeDepth = 0, wells = 0, well9 = 0;
  const holeRows = new Set<number>();
  for (let y = 0; y < H; y++) for (let x = -1; x < W; x++) if (filled(b, x, y) !== filled(b, x + 1, y)) rowTrans++;
  for (let x = 0; x < W; x++) {
    let above = 0, run = 0;
    for (let y = 0; y <= H; y++) {
      if (filled(b, x, y - 1) !== filled(b, x, y)) colTrans++;
      if (y === H) break;
      if (filled(b, x, y)) above++;
      else if (above) { holes++; holeDepth += above; holeRows.add(y); }
      if (!filled(b, x, y) && filled(b, x - 1, y) && filled(b, x + 1, y)) {
        run++;
        wells += run;
        if (x === W - 1) well9 += run;
      } else run = 0;
    }
  }
  return {
    heights, rowTrans, colTrans, holes, holeDepth, wells, well9,
    rowsWithHoles: holeRows.size,
    aggHeight: heights.reduce((a, b) => a + b, 0),
    maxHeight: Math.max(...heights),
    bumpiness: heights.slice(1).reduce((s, v, i) => s + Math.abs(v - heights[i]), 0),
  };
}

export function placementFeatures(prev: Board, prevHoles: number, piece: PieceName, p: Placement): F {
  const cells = ROTATIONS[piece][p.rot].map(([cx, cy]) => [cx + p.col, cy + p.y] as const);
  const bottom = Math.max(...cells.map((c) => c[1]));
  const placed = prev.map((r) => [...r]);
  for (const [x, y] of cells) placed[y][x] = 1;
  const full = new Set(cells.map((c) => c[1]).filter((y) => placed[y].every((v) => v !== 0)));
  let contact = 0;
  for (const [x, y] of cells) for (const [dx, dy] of [[-1, 0], [1, 0], [0, 1]]) if (filled(prev, x + dx, y + dy)) contact++;
  const bf = boardFeatures(p.board);
  const lh = colHeights(placed);
  return {
    ...bf,
    leeAgg: lh.reduce((a, b) => a + b, 0),
    leeHoles: countHoles(placed),
    leeBump: lh.slice(1).reduce((s, v, i) => s + Math.abs(v - lh[i]), 0),
    landing: H - (p.y + bottom) / 2,
    eroded: full.size * cells.filter((c) => full.has(c[1])).length,
    lines: p.lines,
    contact,
    newHoles: bf.holes - prevHoles,
  };
}

// ---------- method plumbing ----------

export type Input = { prev: Board; piece: PieceName; next?: PieceName; options: Placement[]; probs?: number[] };
export type Kind = "classic" | "original" | "learned" | "fusion";
export type Method = { id: string; name: string; kind: Kind; blurb: string; scores: (inp: Input) => number[] };

const featCache = new WeakMap<Input, F[]>();
export function feats(inp: Input): F[] {
  let f = featCache.get(inp);
  if (!f) {
    const ph = boardFeatures(inp.prev).holes;
    f = inp.options.map((p) => placementFeatures(inp.prev, ph, inp.piece, p));
    featCache.set(inp, f);
  }
  return f;
}

export const z = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  return xs.map((x) => (sd ? (x - m) / sd : 0));
};
export const argmax = (xs: number[]) => xs.reduce((bi, x, i) => (x > xs[bi] ? i : bi), 0);
const probsOf = (inp: Input) => inp.probs ?? inp.options.map(() => 1 / inp.options.length);
const lin = (w: Partial<Record<keyof F, number>>) => (f: F) =>
  Object.entries(w).reduce((s, [k, v]) => s + (v ?? 0) * (f[k as keyof F] as number), 0);
const rank = (xs: number[]) => {
  const order = xs.map((_, i) => i).sort((a, b) => xs[b] - xs[a]);
  const r = Array(xs.length).fill(0);
  order.forEach((i, k) => (r[i] = k));
  return r; // 0 = best
};

// ---------- evaluators ----------

// Yiyuan Lee's 4-feature weights (genetic-algorithm tuned).
const LEE = { leeAgg: -0.510066, lines: 0.760666, leeHoles: -0.35663, leeBump: -0.184483 };
// Pierre Dellacherie's 6 features with El-Tetris (Islam El-Ashi) PSO weights.
const DELL = { landing: -4.500158825082766, eroded: 3.4181268101392694, rowTrans: -3.2178882868487753, colTrans: -9.348695305445199, holes: -7.899265427351652, wells: -3.3855972247263626 };
const lee = lin(LEE);
const dell = lin(DELL);
// Board-only value (no placement terms) for rollouts and lookahead leaves.
const boardValue = (b: BoardF) => DELL.rowTrans * b.rowTrans + DELL.colTrans * b.colTrans + DELL.holes * b.holes + DELL.wells * b.wells - 0.5 * b.aggHeight;

const dellScores = (inp: Input) => feats(inp).map(dell);

function wellKeeper(f: F): number {
  const low = f.maxHeight < 12;
  let s = dell(f) - DELL.wells * f.well9; // a single right-edge well is a feature, not a flaw
  if (f.lines === 4) s += 50;
  if (low && f.lines > 0 && f.lines < 4) s -= 6 * f.lines; // save rows for a Tetris while it is safe
  if (low) s -= 5 * f.heights[W - 1]; // keep the well column empty
  return s;
}

const survive = (f: F) => -(10 * f.holes + 4 * f.maxHeight + 0.5 * f.aggHeight + f.bumpiness) + 8 * f.lines;

function hashBoard(b: Board) {
  let h = 2166136261;
  for (const row of b) for (const c of row) h = Math.imul(h ^ (c ? 1 : 0), 16777619);
  return h >>> 0;
}

function greedy(board: Board, piece: PieceName): Placement | null {
  const ps = placements(board, piece);
  if (!ps.length) return null;
  const inp: Input = { prev: board, piece, options: ps };
  return ps[argmax(dellScores(inp))];
}

// ---------- the methods ----------

export const METHODS: Method[] = [
  {
    id: "lee4", name: "Lee 4-feature", kind: "classic",
    blurb: "Linear mix of aggregate height, lines, holes and bumpiness (GA-tuned weights).",
    scores: (inp) => feats(inp).map(lee),
  },
  {
    id: "dellacherie", name: "Dellacherie / El-Tetris", kind: "classic",
    blurb: "Six features: landing height, eroded cells, row and column transitions, holes, wells.",
    scores: dellScores,
  },
  {
    id: "holes-first", name: "Holes first", kind: "classic",
    blurb: "Strict priority: fewest holes, then lowest stack, then flattest surface.",
    scores: (inp) => feats(inp).map((f) => -(f.holes * 1e6 + f.maxHeight * 1e3 + f.bumpiness)),
  },
  {
    id: "transitions", name: "Transitions", kind: "classic",
    blurb: "Minimise filled/empty transitions along rows and columns; a proxy for a tidy surface.",
    scores: (inp) => feats(inp).map((f) => -(f.rowTrans + f.colTrans) - 4 * f.holes),
  },
  {
    id: "lookahead", name: "Lookahead (next piece)", kind: "classic",
    blurb: "Dellacherie on this move plus the best follow-up for the known next piece.",
    scores: (inp) => {
      const base = dellScores(inp);
      if (!inp.next) return base;
      const next = inp.next;
      return inp.options.map((p, i) => {
        const ps = placements(p.board, next);
        if (!ps.length) return -1e9;
        return base[i] + Math.max(...dellScores({ prev: p.board, piece: next, options: ps }));
      });
    },
  },
  {
    id: "well-keeper", name: "Well keeper", kind: "original",
    blurb: "Dellacherie that keeps the right column open and saves rows for 4-line Tetrises while the stack is low.",
    scores: (inp) => feats(inp).map(wellKeeper),
  },
  {
    id: "danger-adaptive", name: "Danger adaptive", kind: "original",
    blurb: "Blends greedy well-keeping with pure survival, sliding toward survival as the stack rises.",
    scores: (inp) => {
      const f = feats(inp);
      const t = Math.min(1, Math.max(0, (boardFeatures(inp.prev).maxHeight - 6) / 8));
      const a = z(f.map(wellKeeper)), b = z(f.map(survive));
      return a.map((v, i) => (1 - t) * v + t * b[i]);
    },
  },
  {
    id: "contour", name: "Contour fit", kind: "original",
    blurb: "Rewards pieces that touch the stack and walls on many sides, like a jigsaw fit.",
    scores: (inp) => feats(inp).map((f) => 3 * f.contact - 6 * f.newHoles - 1.5 * f.landing + 2 * f.lines - 0.5 * f.bumpiness),
  },
  {
    id: "rollout", name: "Monte Carlo rollout", kind: "original",
    blurb: "Plays the 5 best candidates forward with random pieces (greedy Dellacherie) and averages the outcome.",
    scores: (inp) => {
      // ponytail: 5 candidates x 6 rollouts x depth 4. More rollouts = stronger but slower.
      const base = dellScores(inp);
      const cands = new Set(rank(base).map((r, i) => [r, i]).filter(([r]) => r < 5).map(([, i]) => i));
      const rng = mulberry32(hashBoard(inp.prev));
      return inp.options.map((p, i) => {
        if (!cands.has(i)) return base[i] - 1e9;
        let total = 0;
        for (let r = 0; r < 6; r++) {
          let board = p.board, lines = 0, dead = false;
          for (let d = 0; d < 4; d++) {
            const piece = d === 0 && inp.next ? inp.next : PIECES[Math.floor(rng() * PIECES.length)];
            const q = greedy(board, piece);
            if (!q) { dead = true; break; }
            board = q.board;
            lines += q.lines;
          }
          total += dead ? -1e4 : boardValue(boardFeatures(board)) + 10 * lines;
        }
        return total / 6 + 10 * p.lines;
      });
    },
  },
  {
    id: "clef-distilled", name: "Clef-distilled", kind: "learned",
    blurb: "Board-health weights fitted by least squares to clef's own 0-4 ratings of sampled boards.",
    scores: (inp) => feats(inp).map((f) => BOARD_KEYS.reduce((s, k) => s + LEARNED.health[k] * f[k], LEARNED.healthBias)),
  },
  {
    id: "clef-hole-sense", name: "Clef + hole sense", kind: "learned",
    blurb: "Clef-distilled board health, corrected for its blind spot: the fit showed clef barely penalises holes, so holes are added back explicitly.",
    scores: (inp) => {
      const f = feats(inp);
      const health = z(byId("clef-distilled").scores(inp));
      const holeSense = z(f.map((x) => -(x.holes + 0.5 * x.rowsWithHoles + 0.1 * x.holeDepth)));
      // Tuned: weight 1 survived 2/5 benchmark seeds; roughly 1.1-4 survive 5/5. 2 was kept; heavier leaves fewer holes.
      return health.map((v, i) => v + 2 * holeSense[i]);
    },
  },
  {
    id: "move-distilled", name: "Move-distilled + lookahead", kind: "learned",
    blurb: "Softmax-regression weights learned from the model's move probabilities, blended with lookahead.",
    scores: (inp) => {
      const f = feats(inp);
      const learned = z(f.map((x) => BOARD_KEYS.reduce((s, k) => s + LEARNED.move[k] * x[k], LEARNED.moveLines * x.lines)));
      const look = z(byId("lookahead").scores(inp));
      return learned.map((v, i) => 0.5 * v + look[i]);
    },
  },
  {
    id: "poe", name: "Product of experts", kind: "fusion",
    blurb: "log p(model) + z(Dellacherie), equal weight: the model's opinion and the heuristic multiply.",
    scores: (inp) => {
      const p = probsOf(inp), h = z(dellScores(inp));
      return p.map((x, i) => Math.log(x + 1e-6) + h[i]);
    },
  },
  {
    id: "entropy-gate", name: "Entropy gate", kind: "fusion",
    blurb: "Trust shifts smoothly: the flatter the model's distribution, the more the heuristic decides.",
    scores: (inp) => {
      const p = probsOf(inp);
      const ent = -p.reduce((s, x) => s + (x > 0 ? x * Math.log(x) : 0), 0) / Math.log(p.length);
      const m = z(p.map((x) => Math.log(x + 1e-6))), h = z(byId("lookahead").scores(inp));
      return m.map((v, i) => (1 - ent) * v + ent * h[i]);
    },
  },
  {
    id: "shortlist", name: "Heuristic shortlist", kind: "fusion",
    blurb: "Lookahead names its top 3; the model picks among only those.",
    scores: (inp) => {
      const p = probsOf(inp), r = rank(byId("lookahead").scores(inp));
      return p.map((x, i) => (r[i] < 3 ? x + (3 - r[i]) * 1e-9 : -1));
    },
  },
  {
    id: "veto", name: "Heuristic veto", kind: "fusion",
    blurb: "The model's pick stands unless lookahead rates it below average; then its best acceptable option wins.",
    scores: (inp) => {
      const p = probsOf(inp), h = z(byId("lookahead").scores(inp));
      return p.map((x, i) => (h[i] >= 0 ? x + 1e-6 * h[i] : x - 10));
    },
  },
  {
    id: "hole-guard", name: "Hole guard", kind: "fusion",
    blurb: "Targets the blind spot found in the data: keep the model's pick unless it digs a hole that another option avoids; then take the model's favourite hole-free option.",
    scores: (inp) => {
      const p = probsOf(inp), f = feats(inp);
      const minNew = Math.min(...f.map((x) => x.newHoles));
      return p.map((x, i) => (f[i].newHoles <= minNew ? x : x - 10));
    },
  },
  {
    id: "poe-tuned", name: "Product of experts (tuned)", kind: "fusion",
    blurb: "log p(model) + beta * z(lookahead), with beta fitted offline to the model's real decisions.",
    scores: (inp) => {
      const p = probsOf(inp), h = z(byId("lookahead").scores(inp));
      return p.map((x, i) => Math.log(x + 1e-6) + LEARNED.poeBeta * h[i]);
    },
  },
  {
    id: "perplexity-shortlist", name: "Perplexity shortlist", kind: "fusion",
    blurb: "The model's effective number of choices, e^entropy, sets the shortlist size; lookahead picks within it. Confident model = tiny list, flat model = heuristic decides.",
    scores: (inp) => {
      const p = probsOf(inp);
      const ent = -p.reduce((s, x) => s + (x > 0 ? x * Math.log(x) : 0), 0);
      const k = Math.max(1, Math.round(Math.exp(ent)));
      const byModel = rank(p), look = z(byId("lookahead").scores(inp));
      return look.map((v, i) => (byModel[i] < k ? v : v - 100));
    },
  },
  {
    id: "reliability-rank", name: "Reliability-weighted rank fusion", kind: "fusion",
    blurb: "Each source's ranking is weighted by its measured agreement with the oracle (Spearman rho): model ~0.44, lookahead ~0.69.",
    scores: (inp) => {
      const n = inp.options.length;
      const toU = (xs: number[]) => rank(xs).map((r) => 1 - r / Math.max(1, n - 1)); // 1 = best, 0 = worst
      const m = toU(probsOf(inp)), h = toU(byId("lookahead").scores(inp));
      return m.map((v, i) => LEARNED.rhoModel * v + LEARNED.rhoLookahead * h[i]);
    },
  },
  {
    id: "borda", name: "Borda committee", kind: "fusion",
    blurb: "Rank-vote across Lee, Dellacherie, transitions, contour, lookahead and the model.",
    scores: (inp) => {
      const n = inp.options.length;
      const voters = ["lee4", "dellacherie", "transitions", "contour", "lookahead"].map((id) => byId(id).scores(inp));
      if (inp.probs) voters.push(inp.probs); // a flat stand-in vote would rank by list order, not by merit
      const pts = Array(n).fill(0);
      for (const v of voters) rank(v).forEach((r, i) => (pts[i] += n - 1 - r));
      const tie = z(dellScores(inp));
      return pts.map((x, i) => x + 1e-3 * tie[i]);
    },
  },
  {
    id: "minimax-regret", name: "Minimax-regret committee", kind: "fusion",
    blurb: "Picks the option whose worst regret across a heuristic committee (and the model) is smallest: a robust consensus.",
    scores: (inp) => {
      const members = ["lee4", "dellacherie", "transitions", "contour", "lookahead"].map((id) => z(byId(id).scores(inp)));
      members.push(z(probsOf(inp).map((x) => Math.log(x + 1e-6))));
      const best = members.map((m) => Math.max(...m));
      return inp.options.map((_, i) => -Math.max(...members.map((m, j) => best[j] - m[i])));
    },
  },
];

export function byId(id: string): Method {
  const m = METHODS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown method ${id}`);
  return m;
}

export const choose = (id: string, inp: Input) => argmax(byId(id).scores(inp));
