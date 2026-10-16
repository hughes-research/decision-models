"""Tetris rules for the solver. Every table comes from tables.json, generated from the TypeScript engine
(scripts/fixtures.ts), so this file holds logic only. Parity is checked by tests/test_engine.py.

Board = tuple of H row ints, row 0 at the top, bit x set when column x is filled.
State = (x, y, rot): SRS box origin and rotation 0..3, as in lib/srs.ts.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

T = json.loads((Path(__file__).parent / "tables.json").read_text())
W: int = T["W"]
H: int = T["H"]
FULL = (1 << W) - 1
PIECES: list[str] = T["pieces"]
SRS = {p: [tuple((x, y) for x, y in cells) for cells in T["srs"][p]] for p in PIECES}
SPAWN = {p: (s["x"], s["y"], s["rot"]) for p, s in T["spawn"].items()}
# Published kick tables point y up; convert once to our y-down board.
KICKS = {name: {k: [(kx, -ky) for kx, ky in v] for k, v in tab.items()} for name, tab in T["kicks"].items()}
MOVES = {True: T["moves"]["advanced"], False: T["moves"]["basic"]}
LINE_SCORE: list[int] = T["lineScore"]
TSPIN: dict[str, list[int]] = T["tspinPoints"]
SPINS = ["none", "mini", "full"]

Board = tuple[int, ...]
State = tuple[int, int, int]

# Per (piece, rot): (dy, row mask at x = 0) pairs and the min/max cell x for wall checks.
ROWS: dict[str, list[tuple[tuple[int, int], ...]]] = {}
XB: dict[str, list[tuple[int, int]]] = {}
for _p in PIECES:
    ROWS[_p], XB[_p] = [], []
    for _cells in SRS[_p]:
        _rows: dict[int, int] = {}
        for _x, _y in _cells:
            _rows[_y] = _rows.get(_y, 0) | (1 << _x)
        ROWS[_p].append(tuple(sorted(_rows.items())))
        XB[_p].append((min(x for x, _ in _cells), max(x for x, _ in _cells)))


def from_ts(rows: list[list[int]]) -> Board:
    return tuple(sum(1 << x for x, c in enumerate(r) if c) for r in rows)


def hex_board(b: Board) -> str:
    return "".join(f"{r:03x}" for r in b)


def empty() -> Board:
    return (0,) * H


def fits(b: Board, piece: str, x: int, y: int, rot: int) -> bool:
    lo, hi = XB[piece][rot]
    if x + lo < 0 or x + hi >= W:
        return False
    for dy, m in ROWS[piece][rot]:
        yy = y + dy
        if yy < 0 or yy >= H or b[yy] & (m << x if x >= 0 else m >> -x):
            return False
    return True


def grounded(b: Board, piece: str, s: State) -> bool:
    return not fits(b, piece, s[0], s[1] + 1, s[2])


def hard_drop(b: Board, piece: str, s: State) -> State:
    x, y, r = s
    while fits(b, piece, x, y + 1, r):
        y += 1
    return (x, y, r)


def step(b: Board, piece: str, s: State, a: str) -> tuple[State, int] | None:
    """One input; for rotations also the kick test index (0-4) that succeeded."""
    x, y, r = s
    if a in ("left", "right", "down"):
        n = (x - 1, y, r) if a == "left" else (x + 1, y, r) if a == "right" else (x, y + 1, r)
        return (n, -1) if fits(b, piece, *n) else None
    if piece == "O":
        return None
    to = (r + (1 if a == "cw" else 3)) % 4
    for k, (kx, ky) in enumerate(KICKS["I" if piece == "I" else "JLSTZ"][f"{r}{to}"]):
        if fits(b, piece, x + kx, y + ky, to):
            return (x + kx, y + ky, to), k
    return None


_CORNERS = ((0, 0), (2, 0), (0, 2), (2, 2))
_FRONT = (((0, 0), (2, 0)), ((2, 0), (2, 2)), ((0, 2), (2, 2)), ((0, 0), (0, 2)))


def tspin(b: Board, s: State, kick: int) -> str:
    x0, y0, r = s

    def occ(c: tuple[int, int]) -> bool:
        x, y = x0 + c[0], y0 + c[1]
        return x < 0 or x >= W or y >= H or (y >= 0 and (b[y] >> x) & 1 == 1)

    if sum(occ(c) for c in _CORNERS) < 3:
        return "none"
    return "full" if all(occ(c) for c in _FRONT[r]) or kick == 4 else "mini"


def cells(piece: str, s: State) -> list[tuple[int, int]]:
    return sorted((cx + s[0], cy + s[1]) for cx, cy in SRS[piece][s[2]])


def _lock(b: Board, rows_m: tuple[tuple[int, int], ...], x: int, y: int) -> tuple[Board, int, float, int]:
    """Place row masks with the shape's top row at y; return (board, lines, landing height, eroded cells)."""
    rows = list(b)
    for dy, m in rows_m:
        rows[y + dy] |= m << x if x >= 0 else m >> -x
    eroded_cells = sum(m.bit_count() for dy, m in rows_m if rows[y + dy] == FULL)
    kept = [row for row in rows if row != FULL]
    lines = H - len(kept)
    top, bottom = y + rows_m[0][0], y + rows_m[-1][0]
    return tuple([0] * lines + kept), lines, H - (top + bottom) / 2, lines * eroded_cells


def place(b: Board, piece: str, s: State) -> tuple[Board, int]:
    nb, lines, _, _ = _lock(b, ROWS[piece][s[2]], s[0], s[1])
    return nb, lines


def points(lines: int, spin: str, level: int) -> int:
    return level * (LINE_SCORE[lines] if spin == "none" else TSPIN[spin][lines])


@dataclass(slots=True)
class Lock:
    state: State
    spin: str
    board: Board
    lines: int
    landing: float = 0.0  # Dellacherie landing height (H - centre row of the piece)
    eroded: int = 0  # lines cleared x piece cells in them


def reachable(b: Board, piece: str, start: State, advanced: bool) -> list[Lock]:
    """Every lock reachable from start; one per resulting board, keeping the highest spin (as lib/srs.ts)."""
    if not fits(b, piece, *start):
        return []
    moves = MOVES[advanced]
    seen = {start}
    queue = [start]
    spin_rank: dict[State, int] = {}
    i = 0
    while i < len(queue):
        s = queue[i]
        i += 1
        for a in moves:
            r = step(b, piece, s, a)
            if r is None:
                continue
            n, kick = r
            if advanced and piece == "T" and kick >= 0 and grounded(b, piece, n):
                rank = SPINS.index(tspin(b, n, kick))
                if rank > spin_rank.get(n, 0):
                    spin_rank[n] = rank
            if n not in seen:
                seen.add(n)
                queue.append(n)
    best: dict[Board, Lock] = {}
    for s in queue:
        if advanced:
            if not grounded(b, piece, s):
                continue
            lock_s, spin = s, SPINS[spin_rank.get(s, 0)]
        else:
            lock_s, spin = hard_drop(b, piece, s), "none"
        nb, lines, landing, eroded = _lock(b, ROWS[piece][lock_s[2]], lock_s[0], lock_s[1])
        cur = best.get(nb)
        if cur is None or SPINS.index(spin) > SPINS.index(cur.spin):
            best[nb] = Lock(lock_s, spin, nb, lines, landing, eroded)
    return list(best.values())


# ---- fast hard drops from the top (deeper search plies; matches lib/tetris.ts placements()) ----

def _norm_shapes(piece: str) -> list[tuple[tuple[tuple[int, int], ...], int, tuple[int, ...]]]:
    out, seen = [], set()
    for c in SRS[piece]:
        mx, my = min(x for x, _ in c), min(y for _, y in c)
        n = tuple(sorted((x - mx, y - my) for x, y in c))
        if n in seen:
            continue
        seen.add(n)
        w = max(x for x, _ in n) + 1
        rows: dict[int, int] = {}
        for x, y in n:
            rows[y] = rows.get(y, 0) | (1 << x)
        bottom = tuple(max(y for x, y in n if x == cx) for cx in range(w))
        out.append((tuple(sorted(rows.items())), w, bottom))
    return out


NORM = {p: _norm_shapes(p) for p in PIECES}


def tops(b: Board) -> list[int]:
    """Row index of the highest filled cell per column (H when empty)."""
    top, left = [H] * W, FULL
    for y, r in enumerate(b):
        new = r & left
        while new:
            low = new & -new
            top[low.bit_length() - 1] = y
            new ^= low
        left &= ~r
        if not left:
            break
    return top


@lru_cache(maxsize=40_000)  # ponytail: ~30 boards per entry; 40k entries stays well under 1 GB
def drops(b: Board, piece: str) -> tuple[tuple[Board, int, float, int], ...]:
    """All hard-drop results from the top, deduped by board: (board, lines, landing height, eroded cells)."""
    top = tops(b)
    out: dict[Board, tuple[Board, int, float, int]] = {}
    for rows, w, bottom in NORM[piece]:
        for col in range(W - w + 1):
            y = min(top[col + cx] - 1 - bottom[cx] for cx in range(w))
            if y < 0:
                continue
            res = _lock(b, rows, col, y)
            out.setdefault(res[0], res)
    return tuple(out.values())


def add_garbage(b: Board, gap: int) -> Board | None:
    """Push a garbage row (one gap) in from the bottom; None when the stack is pushed off the top."""
    if b[0]:
        return None
    return b[1:] + (FULL & ~(1 << gap),)
