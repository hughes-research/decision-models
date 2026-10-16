"""Behaviour of the planner: it takes Tetrises and T-spins, avoids sealed holes, and keeps to its time limit."""

import json
import time
from pathlib import Path

from orsolver.engine import H, W, SPAWN
from orsolver.evaluate import analyze
from orsolver.search import solve

FX = json.loads((Path(__file__).parent / "fixtures" / "engine.json").read_text())


def ts_rows(name):
    return [[int(c) for c in row] for row in FX["boards"][name]]


def req(board, piece, nxt="O", advanced=False, budget=300, rem=None, node_budget=None):
    x, y, r = SPAWN[piece]
    return {"board": board, "active": {"piece": piece, "x": x, "y": y, "rot": r}, "next": [nxt], "bagRemainder": rem,
            "rules": {"advanced": advanced}, "timing": {"budgetMs": budget}, "solver": {"nodeBudget": node_budget}}


def test_takes_the_tetris():
    out = solve(req(ts_rows("well"), "I"))
    assert out["placement"]["lines"] == 4


def test_takes_the_tspin_double_with_advanced_moves():
    out = solve(req(ts_rows("tsd"), "T", advanced=True))
    assert (out["placement"]["spin"], out["placement"]["lines"]) == ("full", 2)
    plain = solve(req(ts_rows("tsd"), "T", advanced=False))
    assert plain["placement"]["spin"] == "none"


def test_never_seals_a_hole_when_it_can_avoid_it():
    for name in FX["boards"]:
        for piece in "IOTSZLJ":
            out = solve(req(ts_rows(name), piece, budget=60))
            if out["constraints"]["status"] == "ok":
                assert "noNewSealedHoles" not in out["constraints"]["violated"]


def test_keeps_to_a_short_time_limit():
    t = time.perf_counter()
    out = solve(req(ts_rows("random10") if "random10" in FX["boards"] else ts_rows("empty"), "T", budget=50))
    assert (time.perf_counter() - t) * 1000 < 150
    assert out["placement"] is not None


def test_node_budget_is_deterministic():
    a = solve(req(ts_rows("empty"), "L", rem=["I", "T", "S"], node_budget=400))
    b = solve(req(ts_rows("empty"), "L", rem=["I", "T", "S"], node_budget=400))
    assert a["placement"] == b["placement"]
    assert a["stoppedBy"] in ("nodeBudget", "complete")


def test_garbage_landing_now_is_planned_for():
    # A tall stack: when the garbage row arrives right after this piece, any move that leaves a cell in the top
    # row is pushed off the board. The solver must see that and avoid it whenever it can.
    rows = ts_rows("empty")
    for y in range(2, H):
        rows[y] = [1 if x not in (4, 5) else 0 for x in range(W)]
    out = solve({**req(rows, "O", nxt="I"), "rules": {"garbageEvery": 8}, "state": {"piecesUntilGarbage": 1}})
    assert all(y > 0 for _, y in out["placement"]["cells"]), out["placement"]


def test_scenarios_padded_when_few_bag_orders_remain():
    import random
    from orsolver.search import make_scenarios
    assert len(make_scenarios(["I"], 4, 8, random.Random(1))) == 8
    assert len(make_scenarios([], 3, 8, random.Random(1))) == 8
    assert len(make_scenarios(["I", "T", "S"], 3, 8, random.Random(1))) == 6  # exact enumeration, no duplicates
