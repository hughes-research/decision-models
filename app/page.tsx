"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  emptyBoard, makeBag, mulberry32, placements, toOptions, toAscii, LINE_SCORE, W, ROTATIONS, PIECE_ID,
  type Board as BoardT, type PieceName, type Placement,
} from "@/lib/tetris";

const MODELS = ["clef", "clef-flash"] as const;
type Model = (typeof MODELS)[number];

const COLORS = ["", "bg-cyan-400", "bg-yellow-300", "bg-purple-500", "bg-green-500", "bg-red-500", "bg-orange-400", "bg-blue-500"];
const SPIN_MS = 150, SLIDE_MS = 25, DROP_MS = 10;

type Last = { letter: string; text: string; confidence: number; ms: number; top: [string, number][] };
type Game = {
  bag: () => PieceName; rng: () => number;
  board: BoardT; piece: PieceName;
  score: number; lines: number; pieces: number; ms: number[];
  last?: Last; over: boolean; error?: string;
};
type Ghost = { piece: PieceName; rot: number; x: number; y: number; thinking: boolean };
export type Status = { score: number; lines: number; pieces: number; over: boolean };

function newGame(seed: number): Game {
  const bag = makeBag(seed);
  return { bag, rng: mulberry32(seed ^ 0x9e3779b9), board: emptyBoard(), piece: bag(), score: 0, lines: 0, pieces: 0, ms: [], over: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const width = (piece: PieceName, rot: number) => Math.max(...ROTATIONS[piece][rot].map((c) => c[0])) + 1;
const spawnX = (piece: PieceName, rot: number) => Math.floor((W - width(piece, rot)) / 2);

// Remounted (via key) on seed change or reset, so it never needs to reset itself.
function Player({ model, seed, running, onStatus }: {
  model: Model; seed: number; running: boolean; onStatus: (m: Model, s: Status) => void;
}) {
  const [view, setView] = useState(() => newGame(seed)); // render snapshot, lags the game while a drop animates
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const game = useRef({ ...view, ms: [] as number[] }); // mutable game, only touched by the loop below
  const anim = useRef(Promise.resolve()); // animations run in order, off the decision path

  const show = useCallback((snap: Game) => {
    setView(snap);
    onStatus(model, { score: snap.score, lines: snap.lines, pieces: snap.pieces, over: snap.over });
  }, [model, onStatus]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let stopSpin = () => {};
    const queue = (step: () => Promise<void> | void) => { anim.current = anim.current.then(step); };
    const snapshot = (g: Game): Game => ({ ...g, ms: [...g.ms] });

    (async () => {
      const g = game.current;
      g.error = undefined;
      while (!cancelled && !g.over) {
        const piece = g.piece;
        const ps = placements(g.board, piece);
        if (!ps.length) { g.over = true; break; }
        const opts = ps.length === 1 ? null : toOptions(ps, g.rng);
        let pick: Placement = ps[0];

        // Spin at the top while the model thinks (starts once the previous drop has landed).
        const spin = { on: true, timer: undefined as ReturnType<typeof setInterval> | undefined };
        stopSpin = () => { spin.on = false; clearInterval(spin.timer); };
        queue(() => {
          if (!spin.on) return;
          let rot = 0;
          setGhost({ piece, rot, x: spawnX(piece, rot), y: 0, thinking: true });
          spin.timer = setInterval(() => {
            rot = (rot + 1) % ROTATIONS[piece].length;
            setGhost({ piece, rot, x: spawnX(piece, rot), y: 0, thinking: true });
          }, SPIN_MS);
        });

        if (opts) {
          try {
            const res = await fetch("/api/decide", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model, board: toAscii(g.board), piece, options: opts.map(({ letter, text }) => ({ letter, text })) }),
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error ?? res.statusText);
            if (cancelled) return; // paused mid-request: re-ask this piece on resume
            const chosen = opts.find((o) => o.letter === d.letter) ?? opts[0];
            pick = chosen;
            g.ms.push(d.ms);
            g.last = {
              letter: chosen.letter, text: chosen.text, confidence: d.confidence, ms: d.ms,
              top: Object.entries(d.probabilities as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 3)
                .map(([l, p]) => [`${l}: ${opts.find((o) => o.letter === l)?.text ?? "?"}`, p]),
            };
          } catch (e) {
            stopSpin();
            g.error = (e as Error).message;
            break;
          }
        }
        stopSpin();
        g.board = pick.board;
        g.lines += pick.lines;
        g.score += LINE_SCORE[pick.lines];
        g.pieces++;
        g.piece = g.bag();
        const snap = snapshot(g);
        const target = pick;

        // Turn to the chosen rotation, slide to the column, drop, then lock. The next
        // request is already in flight, so this costs the model no race time.
        queue(async () => {
          let x = Math.min(spawnX(piece, target.rot), W - width(piece, target.rot));
          setGhost({ piece, rot: target.rot, x, y: 0, thinking: false });
          while (x !== target.col) {
            await sleep(SLIDE_MS);
            x += Math.sign(target.col - x);
            setGhost({ piece, rot: target.rot, x, y: 0, thinking: false });
          }
          for (let y = 1; y <= target.y; y++) {
            await sleep(DROP_MS);
            setGhost({ piece, rot: target.rot, x, y, thinking: false });
          }
          setGhost(null);
          show(snap);
        });
      }
      const final = snapshot(g);
      queue(() => { setGhost(null); show(final); });
    })();

    return () => {
      cancelled = true;
      stopSpin();
      queue(() => setGhost(null));
    };
  }, [running, model, show]);

  const v = view;
  const avg = v.ms.length ? v.ms.reduce((a, b) => a + b, 0) / v.ms.length : 0;
  const ghostCells = new Map<number, string>();
  if (ghost) {
    for (const [cx, cy] of ROTATIONS[ghost.piece][ghost.rot]) {
      ghostCells.set((cy + ghost.y) * W + cx + ghost.x, `${COLORS[PIECE_ID[ghost.piece]]}${ghost.thinking ? " opacity-60" : ""}`);
    }
  }

  return (
    <section className="flex flex-col gap-3 w-full max-w-[340px]">
      <div className="flex items-baseline justify-between">
        <h2 className="font-mono text-xl font-bold">{model}</h2>
        <span className="font-mono text-sm text-zinc-400">{ghost?.thinking ? "thinking…" : `piece: ${v.piece}`}</span>
      </div>
      <div className="relative">
        <div className="grid gap-px bg-zinc-800 p-px rounded" style={{ gridTemplateColumns: `repeat(${W}, 1fr)` }}>
          {v.board.flat().map((c, i) => (
            <div key={i} className={`aspect-square ${ghostCells.get(i) ?? (c ? COLORS[c] : "bg-zinc-950")}`} />
          ))}
        </div>
        {v.over && (
          <div className="absolute inset-0 grid place-items-center bg-black/70 font-mono text-2xl font-bold text-red-400">TOPPED OUT</div>
        )}
      </div>
      <dl className="grid grid-cols-4 gap-2 font-mono text-center">
        {[["score", v.score], ["lines", v.lines], ["pieces", v.pieces], ["avg ms", Math.round(avg)]].map(([k, v]) => (
          <div key={k} className="rounded bg-zinc-900 py-1">
            <dt className="text-[10px] uppercase text-zinc-500">{k}</dt>
            <dd className="text-lg">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="min-h-28 rounded bg-zinc-900 p-2 font-mono text-xs leading-relaxed">
        {v.error ? (
          <p className="text-red-400">error: {v.error}</p>
        ) : v.last ? (
          <>
            <p className="text-zinc-400">last move: {Math.round(v.last.ms)}ms, confidence {v.last.confidence.toFixed(2)}</p>
            {v.last.top.map(([t, p]) => (
              <p key={t} className={t.startsWith(v.last!.letter + ":") ? "text-green-400" : "text-zinc-500"}>
                {(p * 100).toFixed(0).padStart(3)}% {t}
              </p>
            ))}
          </>
        ) : (
          <p className="text-zinc-500">waiting…</p>
        )}
      </div>
    </section>
  );
}

export default function Home() {
  const [seed, setSeed] = useState(42);
  const [minutes, setMinutes] = useState(3);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState(0);
  const [remaining, setRemaining] = useState(3 * 60_000);
  const [status, setStatus] = useState<Partial<Record<Model, Status>>>({});

  const onStatus = useCallback((m: Model, s: Status) => setStatus((prev) => ({ ...prev, [m]: s })), []);
  const allOver = MODELS.every((m) => status[m]?.over);
  const finished = remaining <= 0 || allOver;
  const active = running && !finished;

  useEffect(() => {
    if (!active) return;
    let t = performance.now();
    const id = setInterval(() => {
      const now = performance.now(), dt = now - t;
      t = now;
      setRemaining((r) => Math.max(0, r - dt));
    }, 200);
    return () => clearInterval(id);
  }, [active]);

  const reset = () => {
    setRunning(false);
    setRunId((n) => n + 1);
    setStatus({});
    setRemaining(minutes * 60_000);
  };

  const [a, b] = MODELS.map((m) => status[m]);
  const winner = !finished || !a || !b ? null
    : a.score !== b.score ? (a.score > b.score ? MODELS[0] : MODELS[1])
    : a.pieces !== b.pieces ? (a.pieces > b.pieces ? MODELS[0] : MODELS[1])
    : "tie";

  const secs = Math.ceil(remaining / 1000);

  return (
    <main className="min-h-screen bg-black text-zinc-100 px-4 py-6 flex flex-col items-center gap-6">
      <header className="text-center">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Clef vs Clef-flash</h1>
        <p className="text-sm text-zinc-400">Same pieces in the same order. Each model drops its next piece as soon as it decides.</p>
      </header>

      <div className="flex flex-wrap items-center justify-center gap-3 font-mono text-sm">
        <button
          onClick={() => setRunning((r) => !r)}
          disabled={finished}
          className="rounded bg-green-600 px-4 py-2 font-bold hover:bg-green-500 disabled:opacity-40"
        >
          {active ? "Pause" : "Start"}
        </button>
        <button onClick={reset} className="rounded bg-zinc-700 px-4 py-2 hover:bg-zinc-600">Reset</button>
        <label className="flex items-center gap-2">
          seed
          <input type="number" value={seed} disabled={active}
            onChange={(e) => { setSeed(Number(e.target.value) || 0); setStatus({}); setRemaining(minutes * 60_000); }}
            className="w-20 rounded bg-zinc-900 px-2 py-1" />
        </label>
        <label className="flex items-center gap-2">
          minutes
          <input type="number" min={1} value={minutes} disabled={active}
            onChange={(e) => { const m = Math.max(1, Number(e.target.value) || 1); setMinutes(m); setRemaining(m * 60_000); }}
            className="w-16 rounded bg-zinc-900 px-2 py-1" />
        </label>
        <span className="text-2xl tabular-nums">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</span>
      </div>

      {winner && (
        <div className="rounded-lg bg-yellow-400 px-6 py-3 font-mono text-xl font-bold text-black">
          {winner === "tie" ? "It's a tie!" : `${winner} wins!`}
        </div>
      )}

      <div className="flex w-full flex-wrap justify-center gap-8">
        {MODELS.map((m) => (
          <Player key={`${m}-${seed}-${runId}`} model={m} seed={seed} running={active} onStatus={onStatus} />
        ))}
      </div>
    </main>
  );
}
