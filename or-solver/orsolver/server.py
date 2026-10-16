"""HTTP service: POST /solve plans a placement; GET /health. Run with
uv run --directory or-solver uvicorn orsolver.server:app --port 8100"""

from __future__ import annotations

import gc
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field, field_validator

from .engine import H, W
from .search import solve

Piece = Literal["I", "O", "T", "S", "Z", "L", "J"]


class Active(BaseModel):
    piece: Piece
    x: int = Field(ge=-3, le=W)
    y: int = Field(ge=-3, le=H)
    rot: int = Field(ge=0, le=3)


class Rules(BaseModel):
    advanced: bool = False
    level: int = Field(1, ge=1)  # unused by the search; no upper bound so long games never get rejected
    gravityMsPerRow: int = Field(0, ge=0)
    lockDelayMs: int = Field(500, ge=0)
    garbageEvery: int = Field(0, ge=0, le=100)


class State(BaseModel):
    piecesUntilGarbage: int = Field(0, ge=0, le=100)


class Timing(BaseModel):
    budgetMs: int = Field(300, ge=10, le=10_000)


class Solver(BaseModel):
    nodeBudget: int | None = Field(None, ge=1, le=10_000_000)


class SolveRequest(BaseModel):
    board: list[list[int]]
    active: Active
    next: list[Piece] = Field(default_factory=list, max_length=6)
    bagRemainder: list[Piece] | None = Field(None, max_length=7)
    rules: Rules = Rules()
    state: State = State()
    timing: Timing = Timing()
    solver: Solver = Solver()

    @field_validator("board")
    @classmethod
    def board_shape(cls, b: list[list[int]]) -> list[list[int]]:
        if len(b) != H or any(len(r) != W or any(c < 0 or c > 8 for c in r) for r in b):
            raise ValueError(f"board must be {H} rows of {W} cells with ids 0-8")
        return b


@asynccontextmanager
async def lifespan(_: FastAPI):
    # One small solve to fill caches and import everything, then keep the GC out of the hot path.
    solve({"board": [[0] * W for _ in range(H)], "active": {"piece": "T", "x": 3, "y": 0, "rot": 0}, "next": ["I"], "timing": {"budgetMs": 50}})
    gc.freeze()
    yield


app = FastAPI(title="Tetris OR solver", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/solve")
def solve_endpoint(req: SolveRequest) -> dict:
    return solve(req.model_dump())
