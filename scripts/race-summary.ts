// Summarises scripts/race.ts results: survival, score, clear mix and paired bootstrap CIs against a baseline.
// Usage: node --no-warnings scripts/race-summary.ts [file=experiments/race.jsonl] [tag=...] [vs=heuristic:lookahead]
import { readFileSync } from "node:fs";
import { mulberry32 } from "../lib/tetris.ts";

const opt = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=") as [string, string]));
type Row = { tag: string; contestant: string; seed: number; garbage: number; minutes: number; toppedOut: boolean; survivedS: number; score: number; pieces: number; lines: number; tspins: number; tetrises: number; late: number; missed?: number; errors?: number; avgThinkMs: number; level: number };
// Last row wins per (tag, contestant, seed, garbage), so re-running a command does not double-count seeds.
const latest = new Map<string, Row>();
for (const r of readFileSync(opt.file ?? "experiments/race.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row)) {
  if ((!opt.tag || r.tag === opt.tag) && r.minutes > 0) latest.set(`${r.tag}|${r.contestant}|${r.seed}|${r.garbage}`, r);
}
const rows = [...latest.values()];
const vs = opt.vs ?? "heuristic:lookahead";
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

// Paired bootstrap 95% CI of mean(a - b) over seeds.
function ci(diffs: number[]): [number, number] {
  const rng = mulberry32(7), boots: number[] = [];
  for (let t = 0; t < 4000; t++) boots.push(mean(diffs.map(() => diffs[Math.floor(rng() * diffs.length)])));
  boots.sort((a, b) => a - b);
  return [boots[100], boots[3899]];
}

const groups = [...new Set(rows.map((r) => `${r.tag}|${r.garbage}`))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
for (const grp of groups) {
  const [tag, g] = grp.split("|");
  const at = rows.filter((r) => r.tag === tag && r.garbage === Number(g));
  console.log(`\n${tag ? `[${tag}] ` : ""}garbage every ${g} pieces (${[...new Set(at.map((r) => r.seed))].length} seeds)`);
  console.log("contestant".padEnd(28) + "survived  mean time  score    lines  T-spins  Tetrises  late  missed  errors  think   survival vs " + vs);
  for (const c of [...new Set(at.map((r) => r.contestant))]) {
    const rs = at.filter((r) => r.contestant === c);
    const base = new Map(at.filter((r) => r.contestant === vs).map((r) => [r.seed, r]));
    const paired = rs.filter((r) => base.has(r.seed)).map((r) => r.survivedS - base.get(r.seed)!.survivedS);
    const [lo, hi] = paired.length > 1 && c !== vs ? ci(paired) : [NaN, NaN];
    console.log(
      c.padEnd(28) + `${rs.filter((r) => !r.toppedOut).length}/${rs.length}`.padEnd(10) + `${mean(rs.map((r) => r.survivedS)).toFixed(0)}s`.padEnd(11) +
      mean(rs.map((r) => r.score)).toFixed(0).padEnd(9) + mean(rs.map((r) => r.lines)).toFixed(0).padEnd(7) +
      mean(rs.map((r) => r.tspins)).toFixed(1).padEnd(9) + mean(rs.map((r) => r.tetrises)).toFixed(1).padEnd(10) +
      mean(rs.map((r) => r.late)).toFixed(1).padEnd(6) + mean(rs.map((r) => r.missed ?? 0)).toFixed(1).padEnd(8) +
      String(rs.reduce((n, r) => n + (r.errors ?? 0), 0)).padEnd(8) + `${mean(rs.map((r) => r.avgThinkMs)).toFixed(0)}ms`.padEnd(8) +
      (c === vs || !paired.length ? "" : `${mean(paired) >= 0 ? "+" : ""}${mean(paired).toFixed(0)}s [${lo.toFixed(0)}, ${hi.toFixed(0)}]`),
    );
  }
}
