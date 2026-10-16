import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyBoard, placements, boardKey, mulberry32, colHeights, PIECES, ROTATIONS, H, type Board, type PieceName } from "./tetris.ts";
import { OLD, SRS, step, tspin, reachable, spawnState, hardDrop, fitsState } from "./srs.ts";

const rows = (...lines: string[]): Board => {
  const b = emptyBoard();
  lines.forEach((l, i) => { const y = H - lines.length + i; [...l].forEach((ch, x) => { if (ch === "X") b[y][x] = 1; }); });
  return b;
};

test("every SRS rotation maps to a normalized ROTATIONS shape, covering all of them", () => {
  for (const p of PIECES) {
    assert.equal(SRS[p].length, 4);
    assert.deepEqual(new Set(OLD[p].map((o) => o.rot)).size, ROTATIONS[p].length, p);
  }
});

test("wall and floor kicks (kick table y points up)", () => {
  const b = emptyBoard();
  assert.deepEqual(step(b, "T", { x: -1, y: 5, rot: 1 }, "cw"), { s: { x: 0, y: 5, rot: 2 }, kick: 1 }); // left wall
  assert.deepEqual(step(b, "T", { x: 4, y: H - 2, rot: 0 }, "cw"), { s: { x: 3, y: H - 3, rot: 1 }, kick: 2 }); // floor kicks UP
  assert.deepEqual(step(b, "I", { x: 7, y: 5, rot: 1 }, "cw"), { s: { x: 6, y: 5, rot: 2 }, kick: 1 }); // right wall
  const well = emptyBoard();
  for (let y = H - 6; y < H; y++) for (let x = 1; x < 10; x++) well[y][x] = 1;
  const inWell = { x: -2, y: H - 4, rot: 1 }; // I upright in column 0
  assert.ok(fitsState(well, "I", inWell));
  assert.equal(step(well, "I", inWell, "cw"), null);
  assert.equal(step(well, "I", inWell, "ccw"), null);
});

test("T-spin 3-corner rule", () => {
  const b = rows("X.X", "...", "X.X"); // corners at rows H-3 and H-1 around a T centred at (1, H-2)
  assert.equal(tspin(b, { x: 0, y: H - 3, rot: 2 }, 0), "full"); // both front (bottom) corners filled
  const c = rows("X..", "...", "X.X");
  assert.equal(tspin(c, { x: 0, y: H - 3, rot: 2 }, 0), "full"); // 3 corners, both front
  assert.equal(tspin(c, { x: 0, y: H - 3, rot: 0 }, 0), "mini"); // 3 corners, only one front (top) corner
  assert.equal(tspin(c, { x: 0, y: H - 3, rot: 0 }, 4), "full"); // 5th kick test upgrades
  assert.equal(tspin(rows("...", "...", "X.X"), { x: 0, y: H - 3, rot: 2 }, 0), "none");
});

test("T-spin double is found only with advanced moves", () => {
  const b = rows("XXXX......", "XXX...XXXX", "XXXX.XXXXX");
  const adv = reachable(b, "T", spawnState("T"), true);
  const tsd = adv.find((p) => p.lines === 2 && p.spin === "full");
  assert.ok(tsd, "no T-spin double found");
  const path = tsd!.path!;
  assert.equal(path[path.length - 1], "drop");
  assert.ok(["cw", "ccw"].includes(path[path.length - 2]), `path should end with a rotation: ${path.join(" ")}`);
  assert.ok(!placements(b, "T").some((p) => p.lines === 2), "plain hard drops should not reach it");
});

test("O tucks under an overhang only with advanced moves", () => {
  const b = emptyBoard();
  b[H - 3][2] = 1; b[H - 3][3] = 1;
  const tuck = reachable(b, "O", spawnState("O"), true).find((p) => p.col === 2 && p.y === H - 2);
  assert.ok(tuck?.tuck, "tuck under the overhang");
  assert.ok(tuck!.path!.includes("down"));
  assert.ok(!reachable(b, "O", spawnState("O"), false).some((p) => p.col === 2 && p.y === H - 2));
  assert.equal(placements(b, "O").find((p) => p.col === 2)!.y, H - 5);
});

function randomBoards(n: number): Board[] {
  const out: Board[] = [];
  const rng = mulberry32(99);
  let b = emptyBoard();
  while (out.length < n) {
    const piece = PIECES[Math.floor(rng() * 7)];
    const ps = placements(b, piece);
    if (!ps.length || Math.max(...colHeights(b)) > 14) { b = emptyBoard(); continue; }
    b = ps[Math.floor(rng() * ps.length)].board;
    out.push(b);
  }
  return out;
}

test("advanced off from spawn equals hard-drop placements(); advanced on is a superset", () => {
  const boards = [emptyBoard(), ...randomBoards(80)];
  for (const b of boards) for (const p of PIECES) {
    const old = new Set(placements(b, p).map((x) => boardKey(x.board)));
    const off = new Set(reachable(b, p, spawnState(p), false).map((x) => boardKey(x.board)));
    assert.deepEqual(off, old, `piece ${p}`);
    const on = new Set(reachable(b, p, spawnState(p), true).map((x) => boardKey(x.board)));
    for (const k of old) assert.ok(on.has(k), `advanced misses a hard drop for ${p}`);
  }
  for (const [p, n] of [["T", 34], ["I", 17], ["O", 9], ["S", 17]] as [PieceName, number][]) {
    assert.equal(reachable(emptyBoard(), p, spawnState(p), true).length, n, p);
  }
});

test("every path replays from the start to its lock state", () => {
  for (const b of randomBoards(25)) for (const p of PIECES) for (const adv of [false, true]) {
    for (const lock of reachable(b, p, spawnState(p), adv)) {
      let s = spawnState(p);
      for (const a of lock.path!) {
        const r = step(b, p, s, a);
        assert.ok(r, `blocked replaying ${lock.path!.join(" ")}`);
        s = r!.s;
      }
      assert.deepEqual(s, lock.state);
      assert.deepEqual(hardDrop(b, p, s), s, "lock state is grounded");
    }
  }
});
