// Headless hard-mode race in simulated time, using the same sim (lib/race.ts) and controllers as the page.
// Gravity runs while a controller "thinks" for its measured latency (or a fixed one, for reproducible runs).
// Usage: node --no-warnings scripts/race.ts [key=value ...] contestant ...
//   keys: seeds=1-10  minutes=3  gravity=1  level=1  garbage=6 (seconds per row; a ladder: garbage=6,4,2.5; 0 = off)  action=80
//         latency=measured|<ms>  tag=<label>  out=experiments/race.jsonl
//   contestants: model:clef-flash  heuristic:lookahead  solver:300   (+adv for advanced moves, +strict for no bag info)
// e.g. node --no-warnings scripts/race.ts seeds=1-5 garbage=6,3 solver:300+adv heuristic:lookahead heuristic:well-keeper
import { appendFileSync, mkdirSync } from "node:fs";
import { createSim, needsDecision, begin, deliver, fail, advance, STEP } from "../lib/race.ts";
import { controllerFor, type BoardCfg, type Transports } from "../lib/controllers.ts";
import { moveRequest } from "../lib/prompt.ts";
import { boardFeatures } from "../lib/heuristics.ts";
import type { EngineConfig } from "../lib/engine.ts";

const OLLAMA = (process.env.OLLAMA_URL ?? "http://localhost:11434") + "/v1/systemone";
const SOLVER = process.env.OR_SOLVER_URL ?? "http://127.0.0.1:8100";

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.includes("=")).map((a) => a.split("=") as [string, string]));
const contestants = args.filter((a) => !a.includes("="));
const range = (s: string) => s.split(",").flatMap((p) => { const [a, b] = p.split("-").map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; });
const SEEDS = range(opt.seeds ?? "1-10");
const LADDER = (opt.garbage ?? "6").split(",").map(Number);
const MINUTES = Number(opt.minutes ?? 3), ACTION = Number(opt.action ?? 80), LATENCY = opt.latency ?? "measured";
const OUT = opt.out ?? "experiments/race.jsonl";
if (!(MINUTES > 0) || !(ACTION > 0) || (LATENCY !== "measured" && !(Number(LATENCY) >= 0)) || SEEDS.some((x) => !Number.isFinite(x)) || LADDER.some((g) => !(g >= 0))) {
  throw new Error("bad minutes/action/latency/seeds/garbage");
}

const json = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(d.error ?? d.detail ?? d));
  return d;
};
const NODE: Transports = {
  decide: async (b) => {
    const d = await json(OLLAMA, moveRequest(b.model, b.board, b.piece, b.options));
    return { letter: d.answers.move.choice, probabilities: d.answers.move.probabilities, confidence: d.answers.move.confidence };
  },
  solve: (b) => json(`${SOLVER}/solve`, b),
};

function parse(spec: string): BoardCfg {
  const [who, ...flags] = spec.split("+");
  const solver = who.startsWith("solver");
  return {
    who: solver ? "solver" : who, assist: "off", gate: 0, budgetMs: solver ? Number(who.split(":")[1] ?? 300) : 300,
    advanced: flags.includes("adv"), strictInfo: flags.includes("strict"),
  };
}

mkdirSync("experiments", { recursive: true });
for (const garbage of LADDER) for (const seed of SEEDS) for (const spec of contestants) {
  const cfg = parse(spec);
  const engine: EngineConfig = { gravity: opt.gravity !== "0", startLevel: Number(opt.level ?? 1), garbageMs: garbage * 1000, lockDelayMs: 500 };
  const s = createSim(engine, seed, cfg.advanced);
  const ctl = controllerFor(cfg, NODE);
  const limit = MINUTES * 60_000;
  const wall = performance.now();
  let lastError: string | null = null;
  while (!s.game.over && s.time < limit) {
    if (!needsDecision(s)) { advance(s, STEP, ACTION); continue; }
    const ctx = begin(s);
    const t = performance.now();
    try {
      const d = await ctl(ctx);
      const lat = LATENCY === "measured" ? performance.now() - t : Number(LATENCY);
      const until = Math.min(s.time + lat, limit); // the race ends at the limit, however long the answer takes
      while (s.time < until && s.game.pieceId === ctx.pieceId && !s.game.over) advance(s, STEP, ACTION);
      deliver(s, ctx.pieceId, d, lat);
    } catch (e) {
      lastError = (e as Error).message;
      fail(s, ctx.pieceId, lastError); // that piece falls under gravity; the next one asks again
    }
  }
  const f = boardFeatures(s.game.board);
  const row = {
    tag: opt.tag ?? "", contestant: spec, seed, garbage, garbageMs: engine.garbageMs, level0: engine.startLevel, gravity: engine.gravity, minutes: MINUTES, action: ACTION, latency: LATENCY,
    pieces: s.game.pieces, lines: s.game.lines, score: s.game.score, level: s.game.level, tspins: s.game.tspins, tetrises: s.game.tetrises,
    toppedOut: s.game.over, overAt: s.overAt === null ? null : s.overAt / 1000, survivedS: (s.overAt ?? s.time) / 1000,
    late: s.stats.late, missed: s.stats.missed, errors: s.stats.errors, fallbacks: s.stats.fallbacks, avgThinkMs: s.stats.decisions ? s.stats.thinkMs / s.stats.decisions : 0,
    holes: f.holes, maxHeight: f.maxHeight, ppp: s.game.pieces ? s.game.score / s.game.pieces : 0, error: lastError, wallS: (performance.now() - wall) / 1000,
  };
  appendFileSync(OUT, JSON.stringify(row) + "\n");
  console.log(`g${String(garbage).padStart(3)}s seed ${String(seed).padStart(2)} ${spec.padEnd(26)} ${row.toppedOut ? `TOPPED OUT ${(row.overAt ?? row.survivedS).toFixed(0)}s` : "survived    "} score ${String(row.score).padStart(6)} pieces ${String(row.pieces).padStart(4)} lines ${String(row.lines).padStart(3)} lvl ${row.level} T-spins ${row.tspins} Tetrises ${row.tetrises} late ${row.late} missed ${row.missed} think ${row.avgThinkMs.toFixed(0)}ms${row.errors ? ` ERRORS ${row.errors}: ${row.error}` : ""}`);
}
