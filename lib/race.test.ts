import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./engine.ts";
import { createSim, begin, deliver, fail, advance, needsDecision, viewOf, STEP, type Sim } from "./race.ts";
import type { Decision } from "./controllers.ts";

const pick = (key: string): Decision => ({ ranked: [key], info: { kind: "heuristic", picked: key, method: "test", computeMs: 0 } });
const runUntilLock = (s: Sim, limitMs = 60_000) => {
  const start = s.game.pieces;
  for (let t = 0; t < limitMs && s.game.pieces === start; t += STEP) advance(s, STEP, 80);
};

test("a decision that arrives after the piece lands is too late: it locked where gravity left it", () => {
  const s = createSim(DEFAULT_CONFIG, 5, false);
  const ctx = begin(s);
  const far = ctx.reach.reduce((a, b) => (Math.abs(b.col - 4) > Math.abs(a.col - 4) ? b : a));
  runUntilLock(s);
  assert.equal(s.stats.late, 1);
  assert.equal(s.game.pieces, 1);
  deliver(s, ctx.pieceId, pick(far.key!), 25_000); // stale: ignored
  assert.equal(s.stats.decisions, 0);
});

test("an instant decision is played out visibly and lands exactly on its target", () => {
  const s = createSim(DEFAULT_CONFIG, 5, true);
  assert.ok(needsDecision(s));
  const ctx = begin(s);
  const target = ctx.reach[ctx.reach.length - 1];
  deliver(s, ctx.pieceId, pick(target.key!), 0);
  assert.equal(viewOf(s).ghost?.kind, "target");
  const seen = new Set<string>();
  for (let t = 0; t < 60_000 && s.game.pieces === 0; t += STEP) {
    advance(s, STEP, 80);
    seen.add(`${s.game.active.x},${s.game.active.y},${s.game.active.rot}`);
  }
  assert.ok(seen.size > 3, "the piece moved through intermediate states");
  assert.deepEqual(s.game.board, target.board);
  assert.equal(s.stats.late, 0);
});

test("same seed: different play, same pieces and the same garbage schedule", () => {
  const cfg = { ...DEFAULT_CONFIG, garbageEvery: 3 };
  const a = createSim(cfg, 11, false), b = createSim(cfg, 11, false);
  for (let n = 0; n < 12; n++) for (const [s, first] of [[a, true], [b, false]] as [Sim, boolean][]) {
    if (s.game.over) continue;
    const ctx = begin(s);
    deliver(s, ctx.pieceId, pick(ctx.reach[first ? 0 : ctx.reach.length - 1].key!), 0);
    runUntilLock(s);
    for (let t = 0; t < 1000 && !needsDecision(s) && !s.game.over; t += STEP) advance(s, STEP, 80); // finish flashes
  }
  const len = Math.min(a.game.dealt.length, b.game.dealt.length);
  assert.deepEqual(a.game.dealt.slice(0, len), b.game.dealt.slice(0, len));
  assert.equal(a.game.garbageRows, Math.floor(a.game.pieces / 3));
  assert.equal(b.game.garbageRows, Math.floor(b.game.pieces / 3));
});

test("a decision that arrives with too little lock delay left is counted as missed, not silently", () => {
  const s = createSim(DEFAULT_CONFIG, 5, false);
  const ctx = begin(s);
  const far = ctx.reach.reduce((a, b) => (Math.abs(b.col - 4) > Math.abs(a.col - 4) ? b : a));
  while (s.game.pieces === 0 && !(s.game.lockMs >= 450)) advance(s, STEP, 80); // grounded, 50ms of lock delay left
  deliver(s, ctx.pieceId, pick(far.key!), 18_000);
  runUntilLock(s);
  assert.equal(s.stats.late, 0);
  assert.equal(s.stats.missed, 1);
  assert.match(s.note ?? "", /lock delay/);
});

test("a failed decision costs only that piece; turn-based it drops straight down and the next piece asks again", () => {
  const s = createSim({ ...DEFAULT_CONFIG, gravity: false }, 5, false);
  const ctx = begin(s);
  fail(s, ctx.pieceId, "solver down");
  assert.equal(s.game.pieces, 1);
  assert.equal(s.stats.errors, 1);
  assert.equal(advance(s, STEP, 80).length, 1, "the forced drop is reported");
  for (let t = 0; t < 1000 && !needsDecision(s); t += STEP) advance(s, STEP, 80);
  assert.ok(needsDecision(s));
  assert.equal(s.error, null);
});
