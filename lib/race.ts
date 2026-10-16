// One board's real-time simulation: the engine plus the decision lifecycle and action playback.
// Gravity never waits. On spawn the controller is asked; while it thinks the piece keeps falling; when its
// answer arrives the piece plays out the path from wherever it is now, one visible action at a time.
// Shared by the browser (requestAnimationFrame) and scripts/race.ts (simulated time).
import { H, mulberry32, type Board, type Cells, type PieceName, type Action } from "./tetris.ts";
import { cellsOf, grounded } from "./srs.ts";
import { createGame, tick, act, pathTo, reachableNow, ghost, bagRemainder, gravityMs, passTime, msUntilGarbage, type EngineConfig, type Game, type LockEvent } from "./engine.ts";
import { choose } from "./heuristics.ts";
import type { Ctx, Decision, Info } from "./controllers.ts";

export const STEP = 10; // ms of game time per simulation step
export const FX_MS = 150; // flash pause for line clears and garbage

type Fx = { board: Board; rows: number[]; kind: "clear" | "garbage"; ms: number };
// late = locked before the decision arrived; missed = the decision arrived but the piece locked elsewhere
// (lock delay ran out mid-move); errors = controller failures (that piece falls under gravity).
export type Stats = { decisions: number; thinkMs: number; late: number; missed: number; fallbacks: number; errors: number; assists: number; overrides: number };

export type Sim = {
  game: Game; time: number; acc: number; rng: () => number; advanced: boolean;
  pending: { pieceId: number; t0: number; ctl?: AbortController } | null;
  target: { key: string; cells: Cells } | null;
  plan: { path: Action[]; from: string } | null; // cached path, valid while the piece is where we left it
  actionClock: number; fx: Fx[]; fxLeft: number;
  seen: Set<string>; // states the current piece was replanned from, to spot kick-up / fall-back loops
  queued: LockEvent[]; // locks made outside advance() (a failed turn-based decision), reported on the next advance
  info: Info | null; note: string | null; error: string | null; overAt: number | null; stats: Stats;
};

export function createSim(cfg: EngineConfig, seed: number, advanced: boolean): Sim {
  return {
    game: createGame(cfg, seed), time: 0, acc: 0, rng: mulberry32(seed ^ 0x9e3779b9), advanced,
    pending: null, target: null, plan: null, actionClock: 0, fx: [], fxLeft: 0, seen: new Set(), queued: [],
    info: null, note: null, error: null, overAt: null,
    stats: { decisions: 0, thinkMs: 0, late: 0, missed: 0, fallbacks: 0, errors: 0, assists: 0, overrides: 0 },
  };
}

export const needsDecision = (s: Sim) => !s.game.over && !s.pending && !s.target && !s.fx.length && !s.error;

// Ask now. The context is the board at spawn; the controller has the whole fall to answer.
export function begin(s: Sim, ctl?: AbortController): Ctx {
  const g = s.game;
  s.pending = { pieceId: g.pieceId, t0: s.time, ctl };
  return {
    pieceId: g.pieceId, board: g.board, piece: g.piece, next: g.next, active: g.active, reach: reachableNow(g, s.advanced),
    level: g.level, advanced: s.advanced, gravity: g.cfg.gravity, gravityMs: gravityMs(g.level), lockDelayMs: g.cfg.lockDelayMs,
    garbageMs: g.cfg.garbageMs, msUntilGarbage: msUntilGarbage(g), pendingGarbage: g.pendingGarbage,
    avgPieceMs: g.pieces && s.time ? Math.max(50, s.time / g.pieces) : 1000, bagRemainder: bagRemainder(g), rng: s.rng,
  };
}

const stateKey = (g: Game) => `${g.pieceId}:${g.active.x},${g.active.y},${g.active.rot}`;

function setTarget(s: Sim, key: string) {
  const p = reachableNow(s.game, s.advanced).find((x) => x.key === key)!;
  s.target = { key, cells: cellsOf(s.game.piece, p.state!) };
  s.plan = null;
}

// The single fallback for every controller: Dellacherie over what is reachable from here.
function fallback(s: Sim, why: string) {
  const reach = reachableNow(s.game, s.advanced);
  s.stats.fallbacks++;
  s.note = why;
  if (!reach.length) { s.target = null; return; }
  setTarget(s, reach[choose("dellacherie", { prev: s.game.board, piece: s.game.piece, options: reach })].key!);
}

export function deliver(s: Sim, pieceId: number, d: Decision, ms: number) {
  if (s.pending?.pieceId !== pieceId || s.game.pieceId !== pieceId) return; // stale: that piece already locked
  s.pending = null;
  s.stats.decisions++;
  s.stats.thinkMs += ms;
  s.info = d.info;
  s.note = null;
  if (d.info.kind === "model") { s.stats.assists += d.info.assisted ? 1 : 0; s.stats.overrides += d.info.overrode ? 1 : 0; }
  const reach = reachableNow(s.game, s.advanced);
  const keys = new Set(reach.map((p) => p.key!));
  const boards = new Map(reach.map((p) => [p.key!.split("|")[0], p.key!]));
  for (let i = 0; i < d.ranked.length; i++) {
    const k = keys.has(d.ranked[i]) ? d.ranked[i] : boards.get(d.ranked[i].split("|")[0]);
    if (!k) continue;
    if (i > 0) s.note = `first pick no longer reachable; took choice #${i + 1}`;
    setTarget(s, k);
    s.actionClock = 0;
    return;
  }
  fallback(s, "its pick is no longer reachable; fell back to Dellacherie");
  s.actionClock = 0;
}

// A failed request costs only that piece: with gravity it falls where it falls; turn-based, it drops straight down.
// No heuristic stands in, which keeps the race honest. The next piece asks again.
export function fail(s: Sim, pieceId: number, err: string) {
  if (s.pending?.pieceId !== pieceId) return;
  s.pending = null;
  s.error = err;
  s.stats.errors++;
  if (!s.game.cfg.gravity) {
    const r = act(s.game, "drop");
    if (r.lock) { onLock(s, r.lock); s.queued.push(r.lock); }
  }
}

export function cancel(s: Sim) {
  s.pending?.ctl?.abort();
  s.pending = null;
}

const cellSet = (cells: Cells) => cells.map(([x, y]) => y * 100 + x).sort((a, b) => a - b).join(",");

function onLock(s: Sim, ev: LockEvent) {
  if (s.pending?.pieceId === ev.pieceId) {
    s.pending.ctl?.abort();
    s.stats.late++;
    s.note = `locked before the decision arrived (${((s.time - s.pending.t0) / 1000).toFixed(1)}s)`;
    s.pending = null;
  } else if (ev.forced && s.target && cellSet(ev.cells) !== cellSet(s.target.cells)) {
    s.stats.missed++;
    s.note = "lock delay ran out before the move finished";
  }
  if (s.error) { s.note = `controller error: ${s.error}`; s.error = null; }
  s.target = null;
  s.plan = null;
  s.seen.clear();
  if (ev.cleared.length) s.fx.push({ board: ev.placed, rows: ev.cleared, kind: "clear", ms: FX_MS });
  if (ev.garbage) s.fx.push({ board: s.game.board, rows: Array.from({ length: ev.garbage }, (_, i) => H - 1 - i), kind: "garbage", ms: FX_MS });
  s.fxLeft = s.fx[0]?.ms ?? 0;
  if (s.game.over) s.overAt ??= s.time; // every top-out happens in a lock, including one made in fail()
}

// Advance game time by `ms` (fixed STEP substeps). Actions cost `actionMs` each; soft drops a quarter of that.
export function advance(s: Sim, ms: number, actionMs: number): LockEvent[] {
  const events: LockEvent[] = s.queued.splice(0);
  const g = s.game;
  s.acc += ms;
  while (s.acc >= STEP) {
    if (needsDecision(s)) break; // stop exactly at spawn so the ask happens at the same game time everywhere
    s.acc -= STEP;
    passTime(g, STEP);
    if (s.fx.length) {
      s.time += STEP;
      s.fxLeft -= STEP;
      if (s.fxLeft <= 0) { s.fx.shift(); s.fxLeft = s.fx[0]?.ms ?? 0; }
      continue;
    }
    if (s.target && !g.over) {
      s.actionClock += STEP;
      for (;;) {
        if (!s.plan || s.plan.from !== stateKey(g)) {
          if (s.seen.has(stateKey(g))) {
            // Back where we replanned before: at this gravity a kick lifts the piece and it falls straight back.
            // Paths ignore gravity between moves, so stop looping and lock it here.
            const r = act(g, "drop");
            s.stats.missed++;
            if (r.lock) { events.push(r.lock); onLock(s, r.lock); }
            s.note = "gravity kept undoing the move; dropped where it was";
            break;
          }
          s.seen.add(stateKey(g));
          const path = pathTo(g, s.target.key, s.advanced);
          if (!path) { fallback(s, "target became unreachable while moving; fell back to Dellacherie"); break; }
          s.plan = { path, from: stateKey(g) };
        }
        let a = s.plan.path[0];
        const showFall = a === "drop" && !grounded(g.board, g.piece, g.active);
        if (showFall) a = "down"; // play the drop row by row so it can be seen
        const cost = a === "down" ? Math.max(STEP, actionMs / 4) : actionMs;
        if (s.actionClock < cost) break;
        s.actionClock -= cost;
        const r = act(g, a);
        if (r.lock) { events.push(r.lock); onLock(s, r.lock); break; }
        if (!r.moved) { fallback(s, "path blocked; fell back to Dellacherie"); break; } // paths come from the current state, so this is a safety net
        s.plan = { path: showFall ? s.plan.path : s.plan.path.slice(1), from: stateKey(g) };
      }
    }
    if (!g.over && !s.fx.length) for (const ev of tick(g, STEP)) { events.push(ev); onLock(s, ev); }
    if (g.over && s.overAt === null) s.overAt = s.time;
    s.time += STEP;
  }
  return events;
}

export type View = {
  key: string; board: Board; flash: number[]; flashKind: "clear" | "garbage" | null;
  piece: { name: PieceName; cells: Cells } | null; ghost: { cells: Cells; kind: "drop" | "target" } | null;
  next: PieceName; level: number; lines: number; score: number; pieces: number; tspins: number; tetrises: number;
  garbageInMs: number | null; garbageQueued: number;
  phase: "idle" | "thinking" | "moving" | "over" | "error"; thinkMs: number | null; lockInMs: number | null;
  info: Info | null; note: string | null; error: string | null; stats: Stats & { avgMs: number };
};

const NO_ROWS: number[] = [];

export function viewOf(s: Sim): View {
  const g = s.game;
  const fx = s.fx[0];
  const live = !g.over && !fx;
  const thinkMs = s.pending ? s.time - s.pending.t0 : null;
  let lockInMs: number | null = null;
  if (s.pending && g.cfg.gravity && live) {
    const rows = ghost(g).y - g.active.y;
    lockInMs = rows > 0 ? rows * gravityMs(g.level) - g.fallMs + g.cfg.lockDelayMs : g.cfg.lockDelayMs - g.lockMs;
  }
  const phase = g.over ? "over" : s.error ? "error" : s.pending ? "thinking" : s.target ? "moving" : "idle";
  return {
    key: [g.pieceId, g.active.x, g.active.y, g.active.rot, g.pieces, s.fx.length, phase, thinkMs === null ? -1 : Math.floor(thinkMs / 100), s.note, s.error, s.target?.key ?? "",
      g.cfg.garbageMs ? Math.floor(msUntilGarbage(g) / 100) : 0, g.pendingGarbage].join("|"),
    board: fx ? fx.board : g.board, flash: fx ? fx.rows : NO_ROWS, flashKind: fx ? fx.kind : null,
    piece: live ? { name: g.piece, cells: cellsOf(g.piece, g.active) } : null,
    ghost: !live ? null : s.target ? { cells: s.target.cells, kind: "target" } : { cells: cellsOf(g.piece, ghost(g)), kind: "drop" },
    next: g.next, level: g.level, lines: g.lines, score: g.score, pieces: g.pieces, tspins: g.tspins, tetrises: g.tetrises,
    garbageInMs: g.cfg.garbageMs ? msUntilGarbage(g) : null, garbageQueued: g.pendingGarbage,
    phase, thinkMs, lockInMs, info: s.info, note: s.note, error: s.error,
    stats: { ...s.stats, avgMs: s.stats.decisions ? s.stats.thinkMs / s.stats.decisions : 0 },
  };
}
