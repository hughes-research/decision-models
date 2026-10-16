import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyBoard, placements, holes, makeBag, toOptions, mulberry32, W, H } from "./tetris.ts";

test("placement counts on empty board", () => {
  assert.equal(placements(emptyBoard(), "I").length, 17);
  assert.equal(placements(emptyBoard(), "O").length, 9);
  assert.equal(placements(emptyBoard(), "T").length, 34);
  assert.equal(placements(emptyBoard(), "S").length, 17);
});

test("filling a row clears it", () => {
  const b = emptyBoard();
  for (let x = 0; x < W - 4; x++) b[H - 1][x] = 1; // gap of 4 on the right
  const flat = placements(b, "I").find((p) => p.rot === 0 && p.col === 6)!;
  assert.equal(flat.lines, 1);
  assert.equal(flat.height, 0);
});

test("holes count", () => {
  const b = emptyBoard();
  b[H - 3][0] = 1; // roof over two empty cells
  b[H - 1][5] = 1; b[H - 2][5] = 1; // no holes in a solid column
  assert.equal(holes(b), 2);
});

test("same seed, same pieces; options capped at 26 with letters", () => {
  const a = makeBag(42), b = makeBag(42);
  const seqA = Array.from({ length: 14 }, a), seqB = Array.from({ length: 14 }, b);
  assert.deepEqual(seqA, seqB);
  assert.equal(new Set(seqA.slice(0, 7)).size, 7);
  const opts = toOptions(placements(emptyBoard(), "T"), mulberry32(1));
  assert.equal(opts.length, 26);
  assert.equal(opts[25].letter, "Z");
});
