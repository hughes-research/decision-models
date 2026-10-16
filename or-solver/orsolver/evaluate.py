"""Board evaluation. El-Tetris-style features plus what the OR solver plans around: overhang cells that a
tuck or spin can still reach (not penalised like sealed holes), T-spin-double slots, and a Tetris well."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from .engine import FULL, H, W, Board

ROW_MASK = (1 << (W + 1)) - 1


@dataclass(slots=True, frozen=True)
class Feat:
    heights: tuple[int, ...]
    agg_height: int
    max_height: int
    bumpiness: int
    holes: int  # every empty cell with a filled cell above it (TS boardFeatures definition)
    closed: int  # holes no falling piece can reach: sealed
    overhang: int  # holes a piece can still slide or spin into
    rows_with_holes: int
    row_trans: int
    col_trans: int
    wells: int
    well_col: int  # the edge column kept as a Tetris well
    well_col_wells: int
    well_depth: int
    tslots: int  # T-spin-double slots ready to take a T


@lru_cache(maxsize=400_000)
def analyze(b: Board) -> Feat:
    heights = [0] * W
    seen = holes = closed = overhang = rows_with_holes = row_trans = col_trans = wells = 0
    prev = 0
    reach = FULL & ~b[0]  # air reachable from the sky moving down and sideways
    runs: dict[int, int] = {}
    col_wells = [0] * W
    for y, r in enumerate(b):
        new = r & ~seen
        while new:
            low = new & -new
            heights[low.bit_length() - 1] = H - y
            new ^= low
        if y:
            e = FULL & ~r
            rr = reach & e
            while True:
                nr = rr | (((rr << 1) | (rr >> 1)) & e)
                if nr == rr:
                    break
                rr = nr
            reach = rr
        covered = seen & ~r
        if covered:
            holes += covered.bit_count()
            rows_with_holes += 1
            closed += (covered & ~reach).bit_count()
            overhang += (covered & reach).bit_count()
        seen |= r
        xw = (r << 1) | 1 | (1 << (W + 1))
        row_trans += ((xw ^ (xw >> 1)) & ROW_MASK).bit_count()
        col_trans += (prev ^ r).bit_count()
        prev = r
        wellrow = (FULL & ~r) & (((r << 1) | 1) & FULL) & ((r >> 1) | (1 << (W - 1)))
        nxt: dict[int, int] = {}
        while wellrow:
            low = wellrow & -wellrow
            x = low.bit_length() - 1
            run = runs.get(x, 0) + 1
            wells += run
            col_wells[x] += run
            nxt[x] = run
            wellrow ^= low
        runs = nxt
    col_trans += (prev ^ FULL).bit_count()
    well_col = 0 if heights[0] <= heights[W - 1] else W - 1
    neighbour = heights[1] if well_col == 0 else heights[W - 2]
    tslots = 0
    for y in range(H - 2):
        r2 = b[y + 2]
        gap = FULL & ~r2
        if gap.bit_count() != 1:
            continue
        x = gap.bit_length() - 2  # slot's left column; the bottom gap is x + 1
        if x < 0 or x > W - 3 or b[y + 1] != FULL & ~(7 << x):
            continue
        top = (b[y] >> x) & 7
        if top in (0b001, 0b100):
            tslots += 1
    return Feat(
        heights=tuple(heights), agg_height=sum(heights), max_height=max(heights),
        bumpiness=sum(abs(heights[i + 1] - heights[i]) for i in range(W - 1)),
        holes=holes, closed=closed, overhang=overhang, rows_with_holes=rows_with_holes,
        row_trans=row_trans, col_trans=col_trans, wells=wells,
        well_col=well_col, well_col_wells=col_wells[well_col], well_depth=max(0, min(4, neighbour - heights[well_col])),
        tslots=tslots,
    )


def is_attack(f: Feat, pending: int = 0) -> bool:
    """Low stack: room to take Tetrises and T-spins. High stack: survive."""
    return f.max_height + pending <= 10


# Pierre Dellacherie's six features with El-Tetris PSO weights: the same evaluator as lib/heuristics.ts.
DELL = (-4.500158825082766, 3.4181268101392694, -3.2178882868487753, -9.348695305445199, -7.899265427351652, -3.3855972247263626)


def dell(board: Board, landing: float, eroded: int) -> float:
    f = analyze(board)
    return (DELL[0] * landing + DELL[1] * eroded + DELL[2] * f.row_trans + DELL[3] * f.col_trans
            + DELL[4] * f.holes + DELL[5] * f.wells)


# The solver's specialised rules: while the stack is safe, T-spins and Tetrises are worth extra, and so is
# leaving a T-spin-double slot open. Under pressure these bonuses switch off and pure survival takes over.
SPIN_BONUS = {"none": (0, 0, 0, 0, 0), "mini": (3, 8, 15, 15, 15), "full": (10, 40, 70, 100, 100)}


def bonus(lines: int, spin: str, after: Board, safe: bool) -> float:
    if not safe:
        return 0.0
    return SPIN_BONUS[spin][lines] + (30.0 if lines == 4 else 0.0) + 6.0 * min(analyze(after).tslots, 1)
