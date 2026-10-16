// Real-time game state: gravity, lock delay, scoring (guideline + T-spins), garbage, levels, top-out.
// Pure and deterministic: time only moves through tick() and passTime(), so the browser and headless scripts share it.
import { W, PIECES, PIECE_ID, GARBAGE, LINE_SCORE, emptyBoard, makeBag, mulberry32, clearLines, type Board, type Cells, type PieceName, type PieceState, type Action, type Spin, type Placement } from "./tetris.ts";
import { spawnState, fitsState, cellsOf, step, tspin, grounded, hardDrop, reachable } from "./srs.ts";

export type EngineConfig = {
  gravity: boolean; // false = turn-based: the piece waits at spawn for its controller
  startLevel: number;
  // One garbage row every garbageMs of game time (0 = off), the same on every board. Rows queue up and are pushed
  // in at the next lock (the versus-Tetris rule), so a slow controller cannot dodge garbage by placing fewer pieces.
  garbageMs: number;
  lockDelayMs: number;
};
export const DEFAULT_CONFIG: EngineConfig = { gravity: true, startLevel: 1, garbageMs: 0, lockDelayMs: 500 };

// Guideline gravity: ms per row = 1000 * (0.8 - (L-1) * 0.007)^(L-1), levels 1..15.
export const GRAVITY_MS = Array.from({ length: 15 }, (_, i) => Math.round(1000 * Math.pow(0.8 - i * 0.007, i)));
export const gravityMs = (level: number) => GRAVITY_MS[Math.min(Math.max(level, 1), 15) - 1];
export const MAX_RESETS = 15;

// ponytail: no back-to-back or combo bonus; add a flag and a 1.5x multiplier when wanted.
const TSPIN_POINTS: Record<Exclude<Spin, "none">, number[]> = { mini: [100, 200, 400, 400], full: [400, 800, 1200, 1600] };
export const points = (lines: number, spin: Spin, level: number) => level * (spin === "none" ? LINE_SCORE[lines] : TSPIN_POINTS[spin][lines]);

export type Game = {
  cfg: EngineConfig; board: Board; bag: () => PieceName; garbageRng: () => number; dealt: PieceName[];
  piece: PieceName; next: PieceName; active: PieceState; pieceId: number;
  fallMs: number; lockMs: number; resets: number; lowest: number; lastKick: number; // lastKick -1 = last move was not a rotation
  score: number; lines: number; level: number; pieces: number; over: boolean;
  tspins: number; tetrises: number; garbageRows: number;
  garbageClock: number; pendingGarbage: number; // ms toward the next row; rows queued for the next lock
};

export type LockEvent = {
  pieceId: number; piece: PieceName; cells: Cells; placed: Board; cleared: number[];
  lines: number; spin: Spin; points: number; garbage: number; forced: boolean; // garbage = rows pushed in; forced = locked by the lock delay
};

function deal(g: Game): PieceName {
  const p = g.bag();
  g.dealt.push(p);
  return p;
}

function spawn(g: Game) {
  g.piece = g.next;
  g.next = deal(g);
  g.active = spawnState(g.piece);
  g.fallMs = 0; g.lockMs = 0; g.resets = 0; g.lowest = g.active.y; g.lastKick = -1;
  g.pieceId++;
  if (!fitsState(g.board, g.piece, g.active)) g.over = true;
}

export function createGame(cfg: EngineConfig, seed: number, board: Board = emptyBoard()): Game {
  const g: Game = {
    cfg, board, bag: makeBag(seed), garbageRng: mulberry32(seed ^ 0x6a09e667), dealt: [],
    piece: "I", next: "I", active: spawnState("I"), pieceId: 0,
    fallMs: 0, lockMs: 0, resets: 0, lowest: 0, lastKick: -1,
    score: 0, lines: 0, level: cfg.startLevel, pieces: 0, over: false, tspins: 0, tetrises: 0, garbageRows: 0,
    garbageClock: 0, pendingGarbage: 0,
  };
  g.next = deal(g);
  spawn(g);
  return g;
}

// The k-th garbage row comes from the k-th draw of its own RNG stream, so every board gets the same rows.
export function addGarbage(g: Game) {
  const gap = Math.floor(g.garbageRng() * W);
  if (g.board[0].some((c) => c !== 0)) g.over = true; // the stack is pushed off the top
  g.board = [...g.board.slice(1), Array.from({ length: W }, (_, x) => (x === gap ? 0 : GARBAGE))];
  g.garbageRows++;
}

function lock(g: Game, forced: boolean): LockEvent {
  const cells = cellsOf(g.piece, g.active);
  const spin: Spin = g.piece === "T" && g.lastKick >= 0 ? tspin(g.board, g.active, g.lastKick) : "none";
  const placed = g.board.map((r) => [...r]);
  for (const [x, y] of cells) placed[y][x] = PIECE_ID[g.piece];
  const cleared = [...new Set(cells.map((c) => c[1]))].filter((y) => placed[y].every((c) => c !== 0)).sort((a, b) => a - b);
  const { board, lines } = clearLines(placed);
  const pts = points(lines, spin, g.level);
  g.score += pts;
  g.lines += lines;
  g.level = g.cfg.startLevel + Math.floor(g.lines / 10);
  g.pieces++;
  g.board = board;
  if (spin !== "none" && lines > 0) g.tspins++;
  if (lines === 4) g.tetrises++;
  const garbage = g.pendingGarbage;
  for (; g.pendingGarbage > 0 && !g.over; g.pendingGarbage--) addGarbage(g);
  g.pendingGarbage = 0;
  const event: LockEvent = { pieceId: g.pieceId, piece: g.piece, cells, placed, cleared, lines, spin, points: pts, garbage, forced };
  if (!g.over) spawn(g);
  return event;
}

// One input. "drop" hard-drops and locks (a 0-row drop keeps a T-spin). Moves while grounded reset the
// lock delay, at most MAX_RESETS times per new lowest row.
export function act(g: Game, a: Action): { moved: boolean; lock?: LockEvent } {
  if (g.over) return { moved: false };
  if (a === "drop") {
    const s = hardDrop(g.board, g.piece, g.active);
    if (s.y !== g.active.y) g.lastKick = -1;
    g.active = s;
    return { moved: true, lock: lock(g, false) };
  }
  const r = step(g.board, g.piece, g.active, a);
  if (!r) return { moved: false };
  const wasGrounded = grounded(g.board, g.piece, g.active);
  g.active = r.s;
  g.lastKick = a === "cw" || a === "ccw" ? r.kick : -1;
  if (a === "down") g.fallMs = 0;
  if (g.active.y > g.lowest) { g.lowest = g.active.y; g.resets = 0; g.lockMs = 0; }
  else if ((wasGrounded || grounded(g.board, g.piece, g.active)) && g.resets < MAX_RESETS) { g.resets++; g.lockMs = 0; }
  return { moved: true };
}

// The garbage clock. Called for every bit of game time (including line-clear flashes and turn-based waits),
// so the queue depends only on time, never on how fast a board plays.
export function passTime(g: Game, ms: number) {
  if (g.over || !g.cfg.garbageMs) return;
  g.garbageClock += ms;
  while (g.garbageClock >= g.cfg.garbageMs) { g.garbageClock -= g.cfg.garbageMs; g.pendingGarbage++; }
}

export const msUntilGarbage = (g: Game) => (g.cfg.garbageMs ? g.cfg.garbageMs - g.garbageClock : 0);

// Advance game time. With gravity the piece falls, and a grounded piece locks after the lock delay.
// Returns as soon as a piece locks, so callers can ask the next piece's controller at the exact moment.
export function tick(g: Game, ms: number): LockEvent[] {
  if (g.over || !g.cfg.gravity) return [];
  let left = ms;
  while (left > 0) {
    if (grounded(g.board, g.piece, g.active)) {
      const need = g.cfg.lockDelayMs - g.lockMs;
      if (left >= need) return [lock(g, true)];
      g.lockMs += left;
      return [];
    }
    const need = gravityMs(g.level) - g.fallMs;
    if (left < need) { g.fallMs += left; return []; }
    left -= need;
    g.fallMs = 0;
    g.active = { ...g.active, y: g.active.y + 1 };
    g.lastKick = -1;
    if (g.active.y > g.lowest) { g.lowest = g.active.y; g.resets = 0; g.lockMs = 0; }
  }
  return [];
}

// Placements reachable from where the piece is right now, each with a path from here.
export const reachableNow = (g: Game, advanced: boolean): Placement[] => (g.over ? [] : reachable(g.board, g.piece, g.active, advanced));

// Path from the current state to the lock with this key (same board with a lower spin is accepted); null if unreachable.
export function pathTo(g: Game, key: string, advanced: boolean): Action[] | null {
  const rs = reachableNow(g, advanced);
  const board = key.split("|")[0];
  const hit = rs.find((p) => p.key === key) ?? rs.find((p) => p.key!.split("|")[0] === board);
  return hit ? hit.path! : null;
}

export const ghost = (g: Game): PieceState => hardDrop(g.board, g.piece, g.active);

// Pieces still to come in the bag that holds `next` (public: it follows from the pieces already dealt).
export function bagRemainder(g: Game): PieceName[] {
  const start = Math.floor((g.dealt.length - 1) / 7) * 7;
  const seen = new Set(g.dealt.slice(start));
  return seen.size === 7 ? [] : PIECES.filter((p) => !seen.has(p));
}
