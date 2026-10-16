import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyBoard, H, W, GARBAGE, type Board } from "./tetris.ts";
import { hardDrop } from "./srs.ts";
import { createGame, tick, act, addGarbage, passTime, pathTo, reachableNow, bagRemainder, gravityMs, points, GRAVITY_MS, DEFAULT_CONFIG } from "./engine.ts";

const CFG = DEFAULT_CONFIG;

test("gravity table and points", () => {
  assert.equal(GRAVITY_MS[0], 1000);
  assert.equal(GRAVITY_MS[1], 793);
  assert.equal(gravityMs(30), 7);
  assert.equal(points(4, "none", 2), 1600);
  assert.equal(points(2, "full", 1), 1200);
  assert.equal(points(1, "mini", 1), 200);
});

test("gravity moves the piece and the lock delay locks it", () => {
  const g = createGame(CFG, 1);
  assert.equal(g.active.y, 0);
  tick(g, 2500);
  assert.equal(g.active.y, 2);
  const g2 = createGame(CFG, 1);
  const rows = hardDrop(g2.board, g2.piece, g2.active).y;
  assert.deepEqual(tick(g2, rows * 1000 + 499), []);
  assert.equal(g2.pieces, 0);
  const [ev] = tick(g2, 1);
  assert.ok(ev?.forced);
  assert.equal(g2.pieces, 1);
  assert.equal(g2.pieceId, 2);
});

test("garbage is deterministic, has one gap, and overflow tops out", () => {
  const a = createGame({ ...CFG, garbageMs: 1000 }, 42), b = createGame({ ...CFG, garbageMs: 1000 }, 42);
  for (let i = 0; i < 5; i++) { addGarbage(a); addGarbage(b); }
  assert.deepEqual(a.board, b.board);
  for (const row of a.board.slice(H - 5)) {
    assert.equal(row.filter((c) => c === 0).length, 1);
    assert.equal(row.filter((c) => c === GARBAGE).length, W - 1);
  }
  const full: Board = emptyBoard();
  full[0][0] = 1;
  const g = createGame(CFG, 1, full);
  addGarbage(g);
  assert.ok(g.over);
});

test("a target becomes unreachable once the piece falls past a pillar", () => {
  const b = emptyBoard();
  for (let y = H - 10; y < H; y++) b[y][7] = 1;
  const g = createGame(CFG, 3, b);
  const right = reachableNow(g, false).find((p) => p.col >= 8)!;
  assert.ok(right && pathTo(g, right.key!, false));
  tick(g, 12_000);
  assert.ok(g.active.y >= 12, `piece fell to ${g.active.y}`);
  assert.equal(pathTo(g, right.key!, false), null);
});

test("a T-spin double played through the engine scores 1200 at level 1", () => {
  const rows = ["XXXX......", "XXX...XXXX", "XXXX.XXXXX"];
  const b = emptyBoard();
  rows.forEach((l, i) => [...l].forEach((ch, x) => { if (ch === "X") b[H - 3 + i][x] = 1; }));
  let seed = 1;
  while (createGame(CFG, seed, b.map((r) => [...r])).piece !== "T") seed++;
  const g = createGame({ ...CFG, gravity: false }, seed, b.map((r) => [...r]));
  const tsd = reachableNow(g, true).find((p) => p.lines === 2 && p.spin === "full")!;
  let ev;
  for (const a of tsd.path!) ev = act(g, a).lock ?? ev;
  assert.equal(ev?.spin, "full");
  assert.equal(ev?.lines, 2);
  assert.equal(g.score, 1200);
  assert.equal(g.tspins, 1);
});

test("bag remainder follows the pieces dealt", () => {
  const g = createGame({ ...CFG, gravity: false }, 7);
  const rem = bagRemainder(g);
  assert.equal(rem.length, 5);
  assert.ok(!rem.includes(g.piece) && !rem.includes(g.next));
  for (let i = 0; i < 5; i++) act(g, "drop");
  assert.equal(g.dealt.length, 7);
  assert.deepEqual(bagRemainder(g), []);
});

test("garbage is on a clock: rows queue by time and land at the next lock", () => {
  const g = createGame({ ...CFG, gravity: false, garbageMs: 2000 }, 3);
  passTime(g, 5000); // a slow controller: 5 seconds, no lock yet
  assert.equal(g.pendingGarbage, 2);
  assert.equal(g.garbageRows, 0);
  const ev = act(g, "drop").lock!;
  assert.equal(ev.garbage, 2);
  assert.equal(g.garbageRows, 2);
  assert.equal(g.pendingGarbage, 0);
  assert.ok(g.board[H - 1].includes(GARBAGE) && g.board[H - 2].includes(GARBAGE));
});
