// SRS movement: rotation states, wall kicks, T-spin detection, and a breadth-first search for every
// reachable lock position with its action path. These tables are exported to the Python solver
// (scripts/fixtures.ts), so this file is the single source of the movement rules.
import {
  W, H, PIECES, ROTATIONS, normalize, toPlacement, holes, boardKey, fits,
  type Board, type Cells, type PieceName, type PieceState, type Action, type Spin, type Placement,
} from "./tetris.ts";

// Spawn shapes in their SRS box (y down). Rotating clockwise in an n-box: (x, y) -> (n - 1 - y, x).
export const SPAWN_SHAPES: Record<PieceName, { n: number; cells: Cells }> = {
  I: { n: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { n: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  T: { n: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { n: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { n: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  L: { n: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  J: { n: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
};

export const SRS: Record<PieceName, Cells[]> = Object.fromEntries(PIECES.map((p) => {
  const { n, cells } = SPAWN_SHAPES[p];
  const out: Cells[] = [cells];
  for (let r = 1; r < 4; r++) out.push(out[r - 1].map(([x, y]) => [n - 1 - y, x] as [number, number]));
  return [p, out];
})) as Record<PieceName, Cells[]>;

// Standard SRS kick tests, written with y pointing UP (as published); applied as (kx, -ky) on our y-down board.
export const KICKS_JLSTZ: Record<string, [number, number][]> = {
  "01": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], "10": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "12": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]], "21": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "23": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], "32": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "30": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]], "03": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
export const KICKS_I: Record<string, [number, number][]> = {
  "01": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]], "10": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "12": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]], "21": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "23": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]], "32": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "30": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]], "03": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

// SRS state rot -> the normalized ROTATIONS index plus offset, so Placement.rot/col/y keep their old meaning.
export const OLD: Record<PieceName, { rot: number; dx: number; dy: number }[]> = Object.fromEntries(PIECES.map((p) => [
  p,
  SRS[p].map((cells) => {
    const n = JSON.stringify(normalize(cells));
    const rot = ROTATIONS[p].findIndex((c) => JSON.stringify(c) === n);
    if (rot < 0) throw new Error(`SRS ${p} rotation not in ROTATIONS`);
    return { rot, dx: Math.min(...cells.map((c) => c[0])), dy: Math.min(...cells.map((c) => c[1])) };
  }),
])) as Record<PieceName, { rot: number; dx: number; dy: number }[]>;

export const spawnState = (piece: PieceName): PieceState => ({ x: piece === "O" ? 4 : 3, y: 0, rot: 0 });
export const cellsOf = (piece: PieceName, s: PieceState): Cells => SRS[piece][s.rot].map(([cx, cy]) => [cx + s.x, cy + s.y]);

export function fitsState(b: Board, piece: PieceName, s: PieceState): boolean {
  for (const [cx, cy] of SRS[piece][s.rot]) {
    const x = cx + s.x, y = cy + s.y;
    if (x < 0 || x >= W || y < 0 || y >= H || b[y][x] !== 0) return false;
  }
  return true;
}

export const grounded = (b: Board, piece: PieceName, s: PieceState) => !fitsState(b, piece, { ...s, y: s.y + 1 });

export function hardDrop(b: Board, piece: PieceName, s: PieceState): PieceState {
  let y = s.y;
  while (fitsState(b, piece, { ...s, y: y + 1 })) y++;
  return { ...s, y };
}

// One input. Returns the new state and, for rotations, which kick test (0-4) succeeded; null if blocked.
export function step(b: Board, piece: PieceName, s: PieceState, a: Action): { s: PieceState; kick: number } | null {
  if (a === "drop") return { s: hardDrop(b, piece, s), kick: -1 };
  if (a === "left" || a === "right" || a === "down") {
    const n = { ...s, x: s.x + (a === "left" ? -1 : a === "right" ? 1 : 0), y: s.y + (a === "down" ? 1 : 0) };
    return fitsState(b, piece, n) ? { s: n, kick: -1 } : null;
  }
  if (piece === "O") return null; // O rotation is a no-op in SRS
  const to = (s.rot + (a === "cw" ? 1 : 3)) % 4;
  const tests = (piece === "I" ? KICKS_I : KICKS_JLSTZ)[`${s.rot}${to}`];
  for (let k = 0; k < tests.length; k++) {
    const n = { x: s.x + tests[k][0], y: s.y - tests[k][1], rot: to };
    if (fitsState(b, piece, n)) return { s: n, kick: k };
  }
  return null;
}

// 3-corner rule around the T's centre (box 1,1). Front corners face the nub. The 5th kick test makes it full.
const CORNERS: [number, number][] = [[0, 0], [2, 0], [0, 2], [2, 2]];
const FRONT: [number, number][][] = [[[0, 0], [2, 0]], [[2, 0], [2, 2]], [[0, 2], [2, 2]], [[0, 0], [0, 2]]];
export function tspin(b: Board, s: PieceState, kick: number): Spin {
  const occ = ([cx, cy]: [number, number]) => {
    const x = s.x + cx, y = s.y + cy;
    return x < 0 || x >= W || y >= H || (y >= 0 && b[y][x] !== 0);
  };
  if (CORNERS.filter(occ).length < 3) return "none";
  return FRONT[s.rot].every(occ) || kick === 4 ? "full" : "mini";
}

const RANK: Spin[] = ["none", "mini", "full"];
const rankOf = (s: Spin) => RANK.indexOf(s);

export function lockPlacement(b: Board, before: number, piece: PieceName, s: PieceState, spin: Spin, path: Action[]): Placement {
  const o = OLD[piece][s.rot];
  const rot = o.rot, col = s.x + o.dx, y = s.y + o.dy;
  const p = toPlacement(b, before, piece, rot, col, y);
  const shape = ROTATIONS[piece][rot];
  let straight = -1;
  if (fits(b, shape, col, 0)) { straight = 0; while (fits(b, shape, col, straight + 1)) straight++; }
  return { ...p, key: `${boardKey(p.board)}|${spin}`, state: s, path, spin, tuck: straight !== y };
}

// Every lock position reachable from `start`, each with a shortest action path ending in "drop".
// advanced = false: rotate and shift where the piece is, then hard drop (today's placements(), from spawn).
// advanced = true: soft drop too, so last-second slides (tucks) and rotations into slots (spins) are found.
// The move order below is part of the contract with the Python solver: paths rotate first, then shift, then drop.
const XO = 3, YO = 3, XS = W + 6, YS = H + 6;
const enc = (s: PieceState) => (s.rot * YS + s.y + YO) * XS + s.x + XO;
const dec = (i: number): PieceState => ({ x: (i % XS) - XO, y: (Math.floor(i / XS) % YS) - YO, rot: Math.floor(i / (XS * YS)) });

export function reachable(b: Board, piece: PieceName, start: PieceState, advanced: boolean): Placement[] {
  if (!fitsState(b, piece, start)) return [];
  const moves: Action[] = advanced ? ["cw", "ccw", "left", "right", "down"] : ["cw", "ccw", "left", "right"];
  const N = 4 * YS * XS;
  const parent = new Int32Array(N).fill(-2), via = new Int8Array(N);
  const spinRank = new Int8Array(N), spinParent = new Int32Array(N), spinVia = new Int8Array(N);
  const queue = [enc(start)];
  parent[queue[0]] = -1;
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h], s = dec(i);
    for (let m = 0; m < moves.length; m++) {
      const r = step(b, piece, s, moves[m]);
      if (!r) continue;
      const j = enc(r.s);
      // A spin depends on the last move being a rotation, so rotation in-edges are recorded even into visited states.
      if (advanced && piece === "T" && r.kick >= 0 && grounded(b, piece, r.s)) {
        const rank = rankOf(tspin(b, r.s, r.kick));
        if (rank > spinRank[j]) { spinRank[j] = rank; spinParent[j] = i; spinVia[j] = m; }
      }
      if (parent[j] !== -2) continue;
      parent[j] = i; via[j] = m;
      queue.push(j);
    }
  }
  const pathTo = (i: number): Action[] => {
    const out: Action[] = [];
    for (let k = i; parent[k] >= 0; k = parent[k]) out.push(moves[via[k]]);
    return out.reverse();
  };

  // Candidate locks: (state, spin, path). Deduped by cells, then by resulting board; higher spin, then shorter path wins.
  type Cand = { s: PieceState; spin: Spin; path: Action[] };
  const better = (a: Cand, b2: Cand) => rankOf(a.spin) - rankOf(b2.spin) || b2.path.length - a.path.length;
  const byCells = new Map<string, Cand>();
  const offer = (c: Cand) => {
    const k = cellsOf(piece, c.s).map(([x, y]) => y * W + x).sort((p, q) => p - q).join(",");
    const cur = byCells.get(k);
    if (!cur || better(c, cur) > 0) byCells.set(k, c);
  };
  for (const i of queue) {
    const s = dec(i);
    if (!advanced) { offer({ s: hardDrop(b, piece, s), spin: "none", path: [...pathTo(i), "drop"] }); continue; }
    if (!grounded(b, piece, s)) continue;
    if (spinRank[i] > 0) offer({ s, spin: RANK[spinRank[i]], path: [...pathTo(spinParent[i]), moves[spinVia[i]], "drop"] });
    const p = pathTo(i);
    while (p.length && p[p.length - 1] === "down") p.pop(); // the final drop covers trailing soft drops
    offer({ s, spin: "none", path: [...p, "drop"] });
  }
  const before = holes(b);
  const byBoard = new Map<string, { c: Cand; p: Placement }>();
  for (const c of byCells.values()) {
    const p = lockPlacement(b, before, piece, c.s, c.spin, c.path);
    const k = boardKey(p.board);
    const cur = byBoard.get(k);
    if (!cur || better(c, cur.c) > 0) byBoard.set(k, { c, p });
  }
  return [...byBoard.values()].map((v) => v.p).sort((a, b2) => a.rot - b2.rot || a.col - b2.col || a.y - b2.y);
}
