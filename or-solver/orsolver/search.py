"""Rolling-horizon planning: plan several pieces ahead, play only the first placement, re-plan every piece.

Every placement is scored with Dellacherie's evaluator (landing height, eroded cells, transitions, holes,
wells) plus the solver's specialised bonuses (T-spins, Tetrises, T-slots) while the stack is safe. A plan's
value is the sum of its placements' scores, so the exact two-piece stage equals the lookahead heuristic;
everything after it is what the OR approach adds:

1. Root moves: every lock reachable now (SRS, with tucks and spins when advanced), filtered by hard constraints.
2. Exact stage over the current and next piece: the fallback answer (on a deadline only finished moves are compared).
3. Bag scenarios: the pieces left in the current 7-bag are known, their order is not. Orders are enumerated
   when few, otherwise sampled (stratified on the first piece); later bags are random; garbage gaps sampled.
4. Each scenario is played out by a beam search; successive halving spends the time budget on the first
   moves still in contention. Stops at the deadline (or node budget) and answers with what it has.
"""

from __future__ import annotations

import itertools
import random
import time
import zlib
from dataclasses import dataclass, field

from .engine import PIECES, SPAWN, H, W, Board, Lock, add_garbage, cells, drops, fits, from_ts, hex_board, reachable
from .evaluate import analyze, bonus, dell, is_attack

GAMMA = 0.9  # weight of each later piece in the plan
DEAD = 1e5  # a top-out costs more than any survivable plan; scaled by depth so dying later is still better


class Deadline(Exception):
    pass


@dataclass
class Clock:
    deadline: float
    node_budget: int | None
    nodes: int = 0
    evals: int = 0

    def tick(self, n: int = 1) -> None:
        self.nodes += n
        if self.node_budget is not None:
            if self.nodes > self.node_budget:
                raise Deadline
        elif time.perf_counter() > self.deadline:
            raise Deadline


# Hard constraints, loosened in this order only when nothing passes. Keeping the spawn area clear is never loosened.
CONSTRAINTS = [("noNewSealedHoles", 1), ("heightCap", 2), ("spawnSafe", 8)]
SPAWN_MASK = 0b1111 << 3  # columns 3-6


def violations(before: Board, lock: Lock, after: Board | None, pending: int) -> list[str]:
    """after = the board the next piece sees (garbage pushed in when it lands right now); None = pushed off the top."""
    fb, fa = analyze(before), analyze(lock.board)
    out = []
    if lock.lines == 0 and fa.closed > fb.closed:
        out.append("noNewSealedHoles")
    if fa.max_height > H - 4 - pending:
        out.append("heightCap")
    if after is None or (after[0] | after[1]) & SPAWN_MASK:
        out.append("spawnSafe")
    return out


def score(before: Board, lock: Lock, safe: bool) -> float:
    return dell(lock.board, lock.landing, lock.eroded) + bonus(lock.lines, lock.spin, lock.board, safe)


@dataclass
class Cand:
    lock: Lock
    s: float  # this placement's score
    violated: list[str]
    rank: int
    root: Board | None  # board the next piece sees (after garbage, if it lands now); None = topped out
    v0: float = 0.0
    samples: list[float] = field(default_factory=list)
    died: list[bool] = field(default_factory=list)


def make_scenarios(rem: list[str] | None, length: int, count: int, rng: random.Random) -> list[list[str]]:
    """Piece orders after `next`. rem = pieces left in the current bag (None = no bag knowledge: independent)."""
    if length <= 0:
        return [[]]
    if rem is None:
        return [[rng.choice(PIECES) for _ in range(length)] for _ in range(count)]

    def extend(prefix: list[str]) -> list[str]:
        seq = list(prefix)
        while len(seq) < length:
            bag = list(PIECES)
            rng.shuffle(bag)
            seq += bag
        return seq[:length]

    k = min(length, len(rem))
    orders = list(itertools.permutations(rem, k)) if k else [()]
    rng.shuffle(orders)  # so the first halving round is not biased toward early pieces
    if len(orders) <= count:
        if k == length:  # the whole horizon is enumerated exactly: duplicates would add nothing
            return [list(o) for o in orders]
        return [extend(list(orders[i % len(orders)])) for i in range(count)]  # fresh random tail each time
    lead = list(rem)
    rng.shuffle(lead)
    out = []
    for i in range(count):  # stratified: every remaining piece leads equally often
        first = lead[i % len(lead)]
        rest = [p for p in rem if p != first]
        rng.shuffle(rest)
        out.append(extend([first] + rest))
    return out


def beam(board: Board, seq: list[str], garbage_at: dict[int, list[int]], width: int, adv: bool, clock: Clock) -> tuple[float, bool]:
    """Best total score of the next len(seq) placements in one scenario (beam search), and whether every line died."""
    frontier: list[tuple[Board, float]] = [(board, 0.0)]
    w = 1.0
    for d, piece in enumerate(seq):
        clock.tick(len(frontier))
        kids: dict[Board, float] = {}
        for b, acc in frontier:
            safe = is_attack(analyze(b))
            if d == 0 and adv:  # the next piece is known: full SRS moves, so spins count
                moves = [(lk.board, lk.lines, lk.landing, lk.eroded, lk.spin) for lk in reachable(b, piece, SPAWN[piece], True)]
            else:
                moves = [(nb, lines, landing, eroded, "none") for nb, lines, landing, eroded in drops(b, piece)]
            for nb, lines, landing, eroded, spin in moves:
                v = acc + w * (dell(nb, landing, eroded) + bonus(lines, spin, nb, safe))
                for gap in garbage_at.get(d, ()):  # rows that land after this placement
                    nb = add_garbage(nb, gap)
                    if nb is None:
                        break
                if nb is None:
                    continue
                if d + 1 < len(seq) and not fits(nb, seq[d + 1], *SPAWN[seq[d + 1]]):
                    continue  # the next piece cannot spawn: top-out
                if v > kids.get(nb, -1e18):
                    kids[nb] = v
        clock.evals += len(kids)
        if not kids:
            return max(acc for _, acc in frontier) - DEAD * w, True  # topped out inside the horizon
        frontier = sorted(kids.items(), key=lambda kv: kv[1], reverse=True)[:width]
        w *= GAMMA
    return frontier[0][1], False


def settings(budget_ms: float) -> tuple[int, int, int, int]:
    """(scenario length after next, beam width, scenarios, first moves kept) for a time budget."""
    if budget_ms < 60:
        return 1, 2, 3, 3
    if budget_ms < 400:
        return 3, 3, 8, 5
    if budget_ms < 1200:
        return 4, 4, 12, 6
    return 5, 5, 16, 8


def describe(c: Cand, before: Board) -> str:
    fb, fa = analyze(before), analyze(c.lock.board)
    bits = []
    if c.lock.spin != "none":
        bits.append(f"{'mini ' if c.lock.spin == 'mini' else ''}T-spin {['zero', 'single', 'double', 'triple'][c.lock.lines]}")
    elif c.lock.lines == 4:
        bits.append("Tetris")
    elif c.lock.lines:
        bits.append(f"clears {c.lock.lines}")
    if fa.closed > fb.closed:
        bits.append(f"+{fa.closed - fb.closed} sealed hole{'s' if fa.closed - fb.closed > 1 else ''}")
    if fa.tslots > fb.tslots:
        bits.append("opens a T-slot")
    if c.violated:
        bits.append("breaks " + ", ".join(c.violated))
    return "; ".join(bits) or "flat and safe"


def solve(req: dict) -> dict:
    t0 = time.perf_counter()
    timing, rules, state, solver = req.get("timing", {}), req.get("rules", {}), req.get("state", {}), req.get("solver") or {}
    b = from_ts(req["board"])
    act = req["active"]
    piece, start = act["piece"], (act["x"], act["y"], act["rot"])
    nxt = (req.get("next") or [None])[0]
    rem = req.get("bagRemainder")
    adv = bool(rules.get("advanced", False))
    # Garbage runs on a clock: rows queued now land when this piece locks; one more row every garbageMs after
    # msUntilGarbage. Lock j (1 = this piece) happens about j * avgPieceMs from now at this board's pace.
    g_ms = float(rules.get("garbageMs", 0))
    queued = int(state.get("pendingGarbage", 0))
    until_ms = float(state.get("msUntilGarbage", g_ms))
    piece_ms = max(50.0, float(state.get("avgPieceMs", 1000)))

    def arrived(t: float) -> int:  # rows queued between now and t ms from now
        return 0 if not g_ms or t < until_ms else 1 + int((t - until_ms) // g_ms)

    def rows_at(j: int) -> int:  # rows pushed in right after lock j
        return (queued if j == 1 else 0) + arrived(j * piece_ms) - arrived((j - 1) * piece_ms)

    pending = rows_at(1) + rows_at(2)

    # Anytime under gravity: thinking time is fall time, so think for at most a quarter of the fall.
    budget = float(timing.get("budgetMs", 300))
    gms = float(rules.get("gravityMsPerRow", 0))
    if gms > 0:
        fall_rows = max(1, H - analyze(b).max_height - start[1] - 2)
        budget = min(budget, max(15.0, 0.25 * fall_rows * gms))
    clock = Clock(deadline=t0 + budget / 1000 * 0.85 - 0.002, node_budget=solver.get("nodeBudget"))

    locks = reachable(b, piece, start, adv)
    if not locks:
        return {"gameOver": True, "placement": None, "alternatives": [], "expected": {"value": 0, "worst": 0, "pTopout": 1},
                "horizon": 0, "nodes": 0, "evals": 0, "scenarios": 0, "budgetMs": round(budget), "solveMs": (time.perf_counter() - t0) * 1000,
                "stoppedBy": "complete", "constraints": {"status": "forced", "violated": []}}
    safe = is_attack(analyze(b), pending)
    weights = dict(CONSTRAINTS)
    rng = random.Random(zlib.crc32(f"{hex_board(b)}{piece}{nxt}{rem}".encode()))
    gaps_now = [rng.randrange(W) for _ in range(rows_at(1))]  # garbage that lands as soon as this piece locks
    cands = []
    for lk in locks:
        root: Board | None = lk.board
        for gap in gaps_now:
            root = add_garbage(root, gap) if root is not None else None
        v = violations(b, lk, root, pending)
        cands.append(Cand(lk, score(b, lk, safe), v, sum(weights[x] for x in v), root))
    best_rank = min(c.rank for c in cands)
    pool = [c for c in cands if c.rank == best_rank]

    # Exact stage over the current and next piece (full SRS moves for `next` too, so spins are seen).
    # On a deadline, only candidates that finished are compared with each other (never mixed depths).
    stopped = "complete"
    order = sorted(pool, key=lambda c: -c.s)
    for c in order:
        c.v0 = c.s if c.root is not None else c.s - DEAD
    finished = len(order) if not nxt else 0
    try:
        if nxt:
            for c in order:
                clock.tick()
                if c.root is not None:
                    kids = reachable(c.root, nxt, SPAWN[nxt], adv)
                    clock.evals += len(kids)
                    s2 = is_attack(analyze(c.root), pending)
                    c.v0 = c.s + max((score(c.root, k, s2) for k in kids), default=-DEAD)
                finished += 1
    except Deadline:
        stopped = "deadline" if clock.node_budget is None else "nodeBudget"
    pool = sorted(order[:finished], key=lambda c: -c.v0) + order[finished:]
    horizon = (2 if nxt else 1) if finished else 1

    # Bag scenarios + beam, successive halving over the strongest first moves.
    length, width, count, keep = settings(budget)
    scen = make_scenarios(rem, length, count, rng)
    gaps = [{d: [rng.randrange(W) for _ in range(rows_at(d + 2))] for d in range(length + 1) if rows_at(d + 2)} for _ in scen]
    alive = pool[:keep] if finished else []
    n = min(4, len(scen))
    done = 0
    if stopped == "complete" and nxt and len(alive) > 1:
        try:
            while True:
                for c in alive:
                    for i in range(len(c.samples), n):
                        if c.root is None:
                            v, died = c.s - DEAD, True
                        else:
                            v, died = beam(c.root, [nxt] + scen[i], gaps[i], width, adv, clock)
                            v += c.s
                        c.samples.append(v)
                        c.died.append(died)
                done = n
                horizon = 2 + length
                if n >= len(scen) or len(alive) <= 2:
                    break
                alive.sort(key=lambda c: -sum(c.samples[:n]) / n)
                alive = alive[: max(2, len(alive) // 2)]
                n = min(len(scen), n * 2)
        except Deadline:
            stopped = "deadline" if clock.node_budget is None else "nodeBudget"

    def value(c: Cand) -> float:
        k = min(len(c.samples), done)
        return sum(c.samples[:k]) / k if k else c.v0

    ranked = sorted(alive, key=value, reverse=True) + [c for c in pool if c not in alive]
    best = ranked[0]
    worst = min(best.samples[:done]) if done else best.v0
    status = "ok" if best_rank == 0 else "forced" if best_rank >= 8 else "relaxed"

    def lock_out(c: Cand) -> dict:
        return {"cells": [list(p) for p in cells(piece, c.lock.state)], "spin": c.lock.spin, "lines": c.lock.lines,
                "value": round(value(c), 2), "why": describe(c, b)}

    return {
        "gameOver": False,
        "placement": lock_out(best),
        "alternatives": [lock_out(c) for c in ranked[1:4]],
        "expected": {"value": round(value(best), 2), "worst": round(worst, 2),
                     "pTopout": round(sum(best.died[:done]) / done, 3) if done else 0.0},
        "horizon": horizon, "nodes": clock.nodes, "evals": clock.evals, "scenarios": done, "budgetMs": round(budget),
        "solveMs": round((time.perf_counter() - t0) * 1000, 1), "stoppedBy": stopped,
        "constraints": {"status": status, "violated": best.violated},
    }
