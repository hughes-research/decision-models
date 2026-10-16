import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyBoard, placements, H } from "./tetris.ts";
import { METHODS, boardFeatures, choose } from "./heuristics.ts";

test("board features on a known board", () => {
  const b = emptyBoard();
  // Bottom row filled except column 9 (a 1-deep well at the right wall), plus a roofed hole in column 0.
  for (let x = 0; x < 9; x++) b[H - 1][x] = 1;
  b[H - 3][0] = 1; // roof over (0, H-2)
  const f = boardFeatures(b);
  assert.equal(f.holes, 1);
  assert.equal(f.holeDepth, 1);
  assert.equal(f.maxHeight, 3);
  assert.equal(f.well9, 1);
  assert.deepEqual(f.heights.slice(0, 3), [3, 1, 1]);
});

test("every method scores every option and picks a legal one", () => {
  const b = emptyBoard();
  for (let x = 0; x < 7; x++) b[H - 1][x] = 1;
  const options = placements(b, "T");
  const probs = options.map((_, i) => (i === 0 ? 0.5 : 0.5 / (options.length - 1)));
  for (const m of METHODS) {
    const s = m.scores({ prev: b, piece: "T", next: "I", options, probs });
    assert.equal(s.length, options.length, m.id);
    assert.ok(s.every(Number.isFinite), m.id);
    const i = choose(m.id, { prev: b, piece: "T", next: "I", options, probs });
    assert.ok(i >= 0 && i < options.length, m.id);
  }
});

test("hole guard keeps a hole-free model pick and overrides a hole-digging one", () => {
  const b = emptyBoard();
  b[H - 1][0] = 1; // an O over columns 0-1 now leaves a hole at column 1
  const options = placements(b, "O");
  const digs = options.findIndex((p) => boardFeatures(p.board).holes > 0);
  const clean = options.findIndex((p) => boardFeatures(p.board).holes === 0);
  assert.ok(digs >= 0 && clean >= 0);
  const favour = (i: number) => options.map((_, k) => (k === i ? 0.9 : 0.1 / (options.length - 1)));
  assert.equal(choose("hole-guard", { prev: b, piece: "O", options, probs: favour(clean) }), clean);
  assert.notEqual(choose("hole-guard", { prev: b, piece: "O", options, probs: favour(digs) }), digs);
});
