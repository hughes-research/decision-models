// The three kinds of controller. Each turns a decision context into a ranked list of placement keys.
// Network calls go through injected transports, so the browser (API routes) and Node scripts (direct) share this.
import { toOptions, toAscii, boardKey, clearLines, PIECE_ID, type Board, type PieceName, type PieceState, type Placement, type Spin, type Cells } from "./tetris.ts";
import { METHODS, byId, choose } from "./heuristics.ts";

export const MODELS = ["clef", "clef-flash"] as const;
export type Model = (typeof MODELS)[number];
// Default assist gate per model, from the offline study: help on roughly the less-confident two-thirds of moves.
export const DEFAULT_GATE: Record<Model, number> = { clef: 0.1, "clef-flash": 0.025 };

// who: "model:clef" | "model:clef-flash" | "solver" | "heuristic:<method id>"
export type BoardCfg = { who: string; assist: string; gate: number; budgetMs: number; advanced: boolean; strictInfo: boolean };
export const LINEUP: BoardCfg[] = [
  { who: "model:clef-flash", assist: "off", gate: DEFAULT_GATE["clef-flash"], budgetMs: 300, advanced: false, strictInfo: false },
  { who: "heuristic:lookahead", assist: "off", gate: 0.025, budgetMs: 300, advanced: false, strictInfo: false },
  { who: "solver", assist: "off", gate: 0.025, budgetMs: 300, advanced: true, strictInfo: false },
];

export function label(cfg: BoardCfg): string {
  if (cfg.who.startsWith("model:")) return cfg.who.slice(6);
  if (cfg.who === "solver") return "OR solver";
  return byId(cfg.who.slice(10)).name;
}

export type Ctx = {
  pieceId: number; board: Board; piece: PieceName; next: PieceName; active: PieceState; reach: Placement[];
  level: number; advanced: boolean; gravity: boolean; gravityMs: number; lockDelayMs: number;
  garbageEvery: number; piecesUntilGarbage: number; bagRemainder: PieceName[]; rng: () => number;
};

export type Info =
  | { kind: "model"; picked: string; confidence: number; top: [string, number][]; assist?: string; assisted: boolean; overrode: boolean }
  | { kind: "heuristic"; picked: string; method: string; computeMs: number }
  | { kind: "solver"; picked: string; spin: Spin; solveMs: number; horizon: number; nodes: number; ev: number; constraints: string; stoppedBy: string; alternatives: string[] };
export type Decision = { ranked: string[]; info: Info };
export type Controller = (ctx: Ctx, signal?: AbortSignal) => Promise<Decision>;

export type DecideReply = { letter: string; probabilities: Record<string, number>; confidence: number };
export type SolveLock = { cells: Cells; spin: Spin; lines: number; value?: number; why?: string };
export type SolveReply = {
  placement: SolveLock; alternatives: SolveLock[]; expected: { value: number }; horizon: number; nodes: number;
  solveMs: number; stoppedBy: string; constraints: { status: string; violated: string[] };
};
export type Transports = {
  decide: (body: { model: string; board: string; piece: string; options: { letter: string; text: string }[] }, signal?: AbortSignal) => Promise<DecideReply>;
  solve: (body: unknown, signal?: AbortSignal) => Promise<SolveReply>;
};

function heuristic(id: string): Controller {
  return async (ctx) => {
    const t = performance.now();
    const scores = byId(id).scores({ prev: ctx.board, piece: ctx.piece, next: ctx.next, options: ctx.reach });
    const order = ctx.reach.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
    return { ranked: order.map((i) => ctx.reach[i].key!), info: { kind: "heuristic", method: id, picked: ctx.reach[order[0]].key!, computeMs: performance.now() - t } };
  };
}

function model(name: string, cfg: BoardCfg, t: Transports): Controller {
  return async (ctx, signal) => {
    if (ctx.reach.length === 1) { // nothing to choose (and the choice question needs 2+ options)
      const k = ctx.reach[0].key!;
      return { ranked: [k], info: { kind: "model", picked: k, confidence: 1, top: [], assisted: false, overrode: false } };
    }
    const opts = toOptions(ctx.reach, ctx.rng);
    const d = await t.decide({ model: name, board: toAscii(ctx.board), piece: ctx.piece, options: opts.map(({ letter, text }) => ({ letter, text })) }, signal);
    const probs = opts.map((o) => d.probabilities[o.letter] ?? 0);
    const order = opts.map((_, i) => i).sort((a, b) => probs[b] - probs[a]);
    let pick = opts.findIndex((o) => o.letter === d.letter);
    if (pick < 0) pick = order[0];
    let assist: string | undefined, assisted = false, overrode = false;
    if (cfg.assist !== "off" && d.confidence < cfg.gate) {
      assisted = true;
      const h = choose(cfg.assist, { prev: ctx.board, piece: ctx.piece, next: ctx.next, options: opts, probs });
      overrode = h !== pick;
      assist = overrode ? `${byId(cfg.assist).name} overrode ${opts[pick].letter} → ${opts[h].letter}` : `${byId(cfg.assist).name} agreed with ${opts[pick].letter}`;
      pick = h;
    }
    const ranked = [opts[pick].key!, ...order.filter((i) => i !== pick).map((i) => opts[i].key!)];
    const top = order.slice(0, 3).map((i) => [`${opts[i].letter}: ${opts[i].text}`, probs[i]] as [string, number]);
    return { ranked, info: { kind: "model", picked: opts[pick].key!, confidence: d.confidence, top, assist, assisted, overrode } };
  };
}

function solver(cfg: BoardCfg, t: Transports): Controller {
  return async (ctx, signal) => {
    const r = await t.solve({
      board: ctx.board,
      active: { piece: ctx.piece, ...ctx.active },
      next: [ctx.next],
      bagRemainder: cfg.strictInfo ? null : ctx.bagRemainder,
      rules: { advanced: ctx.advanced, level: ctx.level, gravityMsPerRow: ctx.gravity ? ctx.gravityMs : 0, lockDelayMs: ctx.lockDelayMs, garbageEvery: ctx.garbageEvery },
      state: { piecesUntilGarbage: ctx.piecesUntilGarbage },
      timing: { budgetMs: cfg.budgetMs },
    }, signal);
    // Map the solver's cells (and spin) to this engine's keys via the board they produce, so the two engines
    // may pick different cells for the same result.
    const keys = new Set(ctx.reach.map((p) => p.key!));
    const toKey = (l: SolveLock) => {
      const placed = ctx.board.map((row) => [...row]);
      for (const [x, y] of l.cells) placed[y][x] = PIECE_ID[ctx.piece];
      const k = `${boardKey(clearLines(placed).board)}|${l.spin}`;
      return keys.has(k) ? k : ctx.reach.find((p) => p.key!.split("|")[0] === k.split("|")[0])?.key;
    };
    const ranked = [r.placement, ...r.alternatives].map(toKey).filter((k): k is string => !!k);
    return {
      ranked,
      info: {
        kind: "solver", picked: ranked[0] ?? "", spin: r.placement.spin, solveMs: r.solveMs, horizon: r.horizon, nodes: r.nodes,
        ev: r.expected.value, constraints: r.constraints.status + (r.constraints.violated.length ? ` (${r.constraints.violated.join(", ")})` : ""),
        stoppedBy: r.stoppedBy, alternatives: r.alternatives.map((a) => a.why ?? "").filter(Boolean),
      },
    };
  };
}

export function controllerFor(cfg: BoardCfg, t: Transports): Controller {
  if (cfg.who.startsWith("model:")) return model(cfg.who.slice(6), cfg, t);
  if (cfg.who === "solver") return solver(cfg, t);
  return heuristic(cfg.who.slice(10));
}

export const HEURISTIC_IDS = METHODS.map((m) => m.id);
