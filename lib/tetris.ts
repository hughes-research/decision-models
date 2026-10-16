// Pure Tetris logic: no React, no I/O. placements() = hard drops; lib/srs.ts adds SRS moves, tucks and spins.

export const W = 10;
export const H = 20;

export type Board = number[][]; // H rows x W cols, 0 = empty, 1..7 = piece id, 8 = garbage
export type PieceName = "I" | "O" | "T" | "S" | "Z" | "L" | "J";
export type Cells = [number, number][]; // [x, y]
export const GARBAGE = 8;

// SRS movement (lib/srs.ts). "down" = soft drop one row, "drop" = hard drop and lock.
export type Action = "left" | "right" | "cw" | "ccw" | "down" | "drop";
export type Spin = "none" | "mini" | "full";
export type PieceState = { x: number; y: number; rot: number }; // SRS box origin, rot 0 = spawn, 1 = R, 2, 3 = L

const SHAPES: Record<PieceName, Cells> = {
  I: [[0, 0], [1, 0], [2, 0], [3, 0]],
  O: [[0, 0], [1, 0], [0, 1], [1, 1]],
  T: [[0, 0], [1, 0], [2, 0], [1, 1]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  L: [[0, 0], [1, 0], [2, 0], [0, 1]],
  J: [[0, 0], [1, 0], [2, 0], [2, 1]],
};
export const PIECES = Object.keys(SHAPES) as PieceName[];
export const PIECE_ID: Record<PieceName, number> = { I: 1, O: 2, T: 3, S: 4, Z: 5, L: 6, J: 7 };

export function normalize(cells: Cells): Cells {
  const mx = Math.min(...cells.map((c) => c[0]));
  const my = Math.min(...cells.map((c) => c[1]));
  return cells.map(([x, y]) => [x - mx, y - my] as [number, number]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

// Distinct rotations: O=1, I/S/Z=2, T/L/J=4.
export const ROTATIONS: Record<PieceName, Cells[]> = Object.fromEntries(
  PIECES.map((p) => {
    const out: Cells[] = [];
    let cur = SHAPES[p];
    for (let r = 0; r < 4; r++) {
      const n = normalize(cur);
      if (!out.some((o) => JSON.stringify(o) === JSON.stringify(n))) out.push(n);
      cur = cur.map(([x, y]) => [y, -x] as [number, number]);
    }
    return [p, out];
  }),
) as Record<PieceName, Cells[]>;

export const emptyBoard = (): Board => Array.from({ length: H }, () => Array(W).fill(0));

export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Seeded 7-bag: same seed -> same piece sequence on both boards.
export function makeBag(seed: number) {
  const rng = mulberry32(seed);
  let bag: PieceName[] = [];
  return (): PieceName => {
    if (!bag.length) bag = shuffle(PIECES, rng);
    return bag.pop()!;
  };
}

export const fits = (b: Board, cells: Cells, ox: number, oy: number) =>
  cells.every(([x, y]) => {
    const cx = x + ox, cy = y + oy;
    return cx >= 0 && cx < W && cy < H && cy >= 0 && b[cy][cx] === 0;
  });

export function clearLines(b: Board): { board: Board; lines: number } {
  const kept = b.filter((row) => row.some((c) => c === 0));
  const lines = H - kept.length;
  return { board: [...Array.from({ length: lines }, () => Array(W).fill(0)), ...kept], lines };
}

export const colHeights = (b: Board) =>
  Array.from({ length: W }, (_, x) => {
    const y = b.findIndex((row) => row[x] !== 0);
    return y === -1 ? 0 : H - y;
  });

export function holes(b: Board): number {
  let n = 0;
  for (let x = 0; x < W; x++) {
    let roof = false;
    for (let y = 0; y < H; y++) {
      if (b[y][x]) roof = true;
      else if (roof) n++;
    }
  }
  return n;
}

export type Placement = {
  rot: number; // index into ROTATIONS[piece] (normalized shape)
  col: number; // left column of the normalized shape
  y: number; // landing row of the normalized shape's top edge
  board: Board;
  lines: number;
  holes: number;
  newHoles: number;
  height: number;
  bumpiness: number;
  // Set by the SRS search (lib/srs.ts); absent for plain hard-drop placements.
  key?: string; // path-independent identity: resulting board + spin
  state?: PieceState; // SRS lock state
  path?: Action[]; // from the search start; always ends with "drop"
  spin?: Spin;
  tuck?: boolean; // not reachable by a straight drop from the top in this rotation and column
};

export const boardKey = (b: Board) => b.map((r) => r.map((c) => (c ? 1 : 0)).join("")).join("");

// The placement for a normalized shape locked at (col, y). Shared by placements() and the SRS search.
export function toPlacement(b: Board, before: number, piece: PieceName, rot: number, col: number, y: number): Placement {
  const placed = b.map((row) => [...row]);
  for (const [cx, cy] of ROTATIONS[piece][rot]) placed[cy + y][cx + col] = PIECE_ID[piece];
  const { board, lines } = clearLines(placed);
  const hs = colHeights(board);
  const h = holes(board);
  return {
    rot, col, y, board, lines,
    holes: h,
    newHoles: h - before,
    height: Math.max(...hs),
    bumpiness: hs.slice(1).reduce((s, v, i) => s + Math.abs(v - hs[i]), 0),
  };
}

export function placements(b: Board, piece: PieceName): Placement[] {
  const before = holes(b);
  const seen = new Set<string>();
  const out: Placement[] = [];
  ROTATIONS[piece].forEach((cells, rot) => {
    const w = Math.max(...cells.map((c) => c[0])) + 1;
    for (let col = 0; col + w <= W; col++) {
      if (!fits(b, cells, col, 0)) continue; // blocked at spawn
      let y = 0;
      while (fits(b, cells, col, y + 1)) y++;
      const p = toPlacement(b, before, piece, rot, col, y);
      const key = boardKey(p.board);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  });
  return out;
}

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type Option<P extends Placement = Placement> = P & { letter: string; text: string };

const SPIN_RANK: Record<Spin, number> = { none: 0, mini: 1, full: 2 };
export const spinRank = (p: Placement) => SPIN_RANK[p.spin ?? "none"];

export const describe = (p: Placement) =>
  `rotation ${p.rot}, column ${p.col}: clears ${p.lines} line${p.lines === 1 ? "" : "s"}, ${p.newHoles >= 0 ? "+" : ""}${p.newHoles} holes (total ${p.holes}), max height ${p.height}, bumpiness ${p.bumpiness}` +
  (p.tuck ? ", tucked under an overhang" : "") + (p.spin === "full" ? ", T-spin" : p.spin === "mini" ? ", mini T-spin" : "");

// Choice questions allow at most 26 options, and the model breaks ties toward the
// first option, so trim to 26 and shuffle so list order gives it no hint.
export function toOptions<P extends Placement>(ps: P[], rng: () => number): Option<P>[] {
  // ponytail: T/L/J can have up to 34 placements (more with tucks); keep spins first, then the least-bad by
  // holes then height. If this trimming matters, switch to a two-stage choice (pick rotation, then column).
  const kept = ps.length > 26 ? [...ps].sort((a, b) => spinRank(b) - spinRank(a) || a.holes - b.holes || a.height - b.height).slice(0, 26) : ps;
  return shuffle(kept, rng).map((p, i) => ({ ...p, letter: LETTERS[i], text: describe(p) }));
}

export const toAscii = (b: Board) => b.map((r) => r.map((c) => (c ? "#" : ".")).join("")).join("\n");

export const LINE_SCORE = [0, 100, 300, 500, 800];
