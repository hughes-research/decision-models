"use client";

import { memo, useEffect, useRef, useState } from "react";
import { createSim, advance, needsDecision, begin, deliver, fail, cancel, viewOf, type Sim, type View } from "@/lib/race";
import { controllerFor, label, MODELS, DEFAULT_GATE, type BoardCfg, type Model, type Transports } from "@/lib/controllers";
import { METHODS, byId, type Kind } from "@/lib/heuristics";
import { ROTATIONS, PIECE_ID, W, H, type Board as BoardT, type Cells, type PieceName } from "@/lib/tetris";
import type { EngineConfig } from "@/lib/engine";

const KIND_LABEL: Record<Kind, string> = { classic: "Heuristic: classic", original: "Heuristic: original", learned: "Heuristic: learned from the model", fusion: "Heuristic: fusion (no model here)" };
const BUDGETS = [50, 300, 1000, 2000];

export type Status = { score: number; lines: number; pieces: number; level: number; over: boolean; overAt: number | null };

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `${r.status} ${r.statusText}`);
  return d as T;
}
const WEB: Transports = { decide: (b, s) => post("/api/decide", b, s), solve: (b, s) => post("/api/solve", b, s) };

// Blocks are vector tiles in the classic bevelled style: a bright top-left rim, a dark bottom-right rim and a
// square face with a highlight. Shades per piece id: [face, top rim, left rim, right rim, bottom rim].
const SHADES: Record<number, [string, string, string, string, string]> = {
  1: ["#2e8fea", "#9ad0ff", "#63b0f7", "#1c69bd", "#124c8c"], // I light blue
  2: ["#e3ad17", "#ffe27a", "#f5c844", "#a87b06", "#7a5703"], // O mustard
  3: ["#b23ca9", "#f0a2ea", "#d670cd", "#7f2378", "#5c1557"], // T purple
  4: ["#3e9d3a", "#a6e3a1", "#6fc469", "#276f24", "#1a4f18"], // S green
  5: ["#d8343c", "#ff9ca0", "#f0646a", "#9c1f25", "#701419"], // Z red
  6: ["#ec6b16", "#ffc27a", "#f99340", "#ab470a", "#7c3205"], // L orange
  7: ["#2648c9", "#8ea6ff", "#5874ea", "#172f8f", "#0f2068"], // J blue
  8: ["#6b7280", "#b4b8c2", "#8d939e", "#4b505b", "#353942"], // garbage
};

// Rendered once per page; every board, overlay and preview <use>s these symbols.
export function TileDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <defs>
        {Object.entries(SHADES).map(([id, [face, top, left, right, bottom]]) => (
          <symbol key={id} id={`tile-${id}`} viewBox="0 0 10 10">
            <polygon points="0,0 10,0 7.6,2.4 2.4,2.4" fill={top} />
            <polygon points="0,0 2.4,2.4 2.4,7.6 0,10" fill={left} />
            <polygon points="10,0 10,10 7.6,7.6 7.6,2.4" fill={right} />
            <polygon points="0,10 2.4,7.6 7.6,7.6 10,10" fill={bottom} />
            <rect x="2.4" y="2.4" width="5.2" height="5.2" fill={face} />
            <path d="M3.1 6.9V3.1H6.9" fill="none" stroke={top} strokeWidth="0.55" opacity="0.9" />
            <path d="M3.1 6.9H6.9V3.1" fill="none" stroke={right} strokeWidth="0.55" opacity="0.55" />
            <rect x="0.15" y="0.15" width="9.7" height="9.7" fill="none" stroke="#000" strokeOpacity="0.45" strokeWidth="0.3" />
          </symbol>
        ))}
        <pattern id="cell-grid" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M10 0H0V10" fill="none" stroke="#1f1f23" strokeWidth="0.6" />
        </pattern>
      </defs>
    </svg>
  );
}

const Tile = ({ id, x, y }: { id: number; x: number; y: number }) => <use href={`#tile-${id}`} x={x * 10} y={y * 10} width={10} height={10} />;

const Grid = memo(function Grid({ board, flash, flashKind }: { board: BoardT; flash: number[]; flashKind: View["flashKind"] }) {
  return (
    <svg viewBox={`0 0 ${W * 10} ${H * 10}`} className="block w-full rounded border border-zinc-800 bg-zinc-950" role="img" aria-label="playfield">
      <rect width={W * 10} height={H * 10} fill="url(#cell-grid)" />
      {board.flatMap((row, y) => row.map((c, x) => (c ? <Tile key={y * W + x} id={c} x={x} y={y} /> : null)))}
      {flash.map((y) => (
        <rect key={`f${y}`} y={y * 10} width={W * 10} height={10} fill={flashKind === "clear" ? "#fff" : "#d4d4d8"} opacity={0.75} className="animate-pulse" />
      ))}
    </svg>
  );
});

function Overlay({ view }: { view: View }) {
  const target = view.ghost?.kind === "target";
  return (
    <svg viewBox={`0 0 ${W * 10} ${H * 10}`} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
      {view.ghost?.cells.map(([x, y], i) => (
        <rect key={`g${i}`} x={x * 10 + 0.8} y={y * 10 + 0.8} width={8.4} height={8.4} rx={0.8} fill="none"
          stroke={target ? "#fcd34d" : "#ffffff"} strokeOpacity={target ? 0.95 : 0.35} strokeWidth={target ? 1.1 : 0.7} strokeDasharray={target ? "2.2 1.4" : undefined} />
      ))}
      {view.piece?.cells.map(([x, y], i) => <Tile key={`p${i}`} id={PIECE_ID[view.piece!.name]} x={x} y={y} />)}
    </svg>
  );
}

function Preview({ piece }: { piece: PieceName }) {
  const cells: Cells = ROTATIONS[piece][0];
  return (
    <svg viewBox="0 0 40 20" className="w-12" role="img" aria-label={`next piece ${piece}`}>
      {cells.map(([x, y]) => <Tile key={`${x},${y}`} id={PIECE_ID[piece]} x={x} y={y} />)}
    </svg>
  );
}

function Panel({ view, cfg }: { view: View; cfg: BoardCfg }) {
  const info = view.info;
  return (
    <div className="min-h-32 rounded bg-zinc-900 p-2 font-mono text-[11px] leading-relaxed">
      {view.phase === "thinking" && view.thinkMs !== null && (
        <div className="mb-1">
          <div className="flex justify-between text-sky-300">
            <span>thinking {(view.thinkMs / 1000).toFixed(1)}s</span>
            {view.lockInMs !== null && <span className={view.lockInMs < 800 ? "text-red-400" : ""}>locks in {(view.lockInMs / 1000).toFixed(1)}s</span>}
          </div>
          {view.lockInMs !== null && (
            <div className="h-1 rounded bg-zinc-800">
              <div className="h-1 rounded bg-sky-400" style={{ width: `${Math.min(100, (100 * view.thinkMs) / (view.thinkMs + Math.max(0, view.lockInMs)))}%` }} />
            </div>
          )}
        </div>
      )}
      {view.error ? <p className="text-red-400">error: {view.error}</p> : !info ? <p className="text-zinc-500">waiting…</p> : info.kind === "model" ? (
        <>
          <p className="text-zinc-400">confidence {info.confidence.toFixed(2)}</p>
          {info.top.map(([t, p]) => <p key={t} className="truncate text-zinc-500" title={t}>{(p * 100).toFixed(0).padStart(3)}% {t}</p>)}
          {info.assist && <p className="text-amber-400">{info.assist}</p>}
        </>
      ) : info.kind === "heuristic" ? (
        <>
          <p className="text-zinc-400">{byId(info.method).name} · {info.computeMs.toFixed(1)}ms</p>
          <p className="text-zinc-500">{byId(info.method).blurb}</p>
        </>
      ) : (
        <>
          <p className="text-zinc-400">
            {info.spin !== "none" ? <span className="text-fuchsia-400">{info.spin === "full" ? "T-spin " : "mini T-spin "}</span> : null}
            horizon {info.horizon} · {info.nodes} nodes · {Math.round(info.solveMs)}ms of {cfg.budgetMs} · {info.stoppedBy}
          </p>
          <p className="text-zinc-500">expected value {info.ev.toFixed(1)} · constraints {info.constraints}</p>
          {info.alternatives.slice(0, 2).map((a, i) => <p key={i} className="truncate text-zinc-600">alt: {a}</p>)}
        </>
      )}
      {view.note && <p className="text-amber-400">{view.note}</p>}
    </div>
  );
}

function Picker({ cfg, onCfg, disabled }: { cfg: BoardCfg; onCfg: (c: BoardCfg) => void; disabled: boolean }) {
  const isModel = cfg.who.startsWith("model:");
  return (
    <div className="flex min-h-[4.5rem] flex-col gap-1 font-mono text-xs"> {/* same height for every controller kind, so the playfields line up */}
      <select value={cfg.who} disabled={disabled} aria-label="controller"
        onChange={(e) => {
          const who = e.target.value;
          onCfg({ ...cfg, who, gate: who.startsWith("model:") ? DEFAULT_GATE[who.slice(6) as Model] : cfg.gate });
        }}
        className="rounded bg-zinc-900 px-2 py-1 text-zinc-100">
        <optgroup label="Decision model">{MODELS.map((m) => <option key={m} value={`model:${m}`}>{m}</option>)}</optgroup>
        <optgroup label="Operations research"><option value="solver">OR solver (Python)</option></optgroup>
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <optgroup key={k} label={KIND_LABEL[k]}>
            {METHODS.filter((m) => m.kind === k).map((m) => <option key={m.id} value={`heuristic:${m.id}`}>{m.name}</option>)}
          </optgroup>
        ))}
      </select>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-400">
        <label className="flex items-center gap-1" title="Tucks (last-second slides under overhangs) and T/L spins via SRS wall kicks">
          <input type="checkbox" checked={cfg.advanced} onChange={(e) => onCfg({ ...cfg, advanced: e.target.checked })} /> advanced moves
        </label>
        {isModel && (
          <>
            <select value={cfg.assist} onChange={(e) => onCfg({ ...cfg, assist: e.target.value })} aria-label="assist" className="max-w-36 rounded bg-zinc-900 px-1 py-0.5 text-zinc-100">
              <option value="off">assist: off</option>
              {METHODS.map((m) => <option key={m.id} value={m.id}>assist: {m.name}</option>)}
            </select>
            <label className="flex items-center gap-1" title="The assist steps in when the model's confidence is below this. 1 = every move.">
              conf &lt;
              <input type="number" step={0.005} min={0} max={1} value={cfg.gate} disabled={cfg.assist === "off"}
                onChange={(e) => onCfg({ ...cfg, gate: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })}
                className="w-14 rounded bg-zinc-900 px-1 disabled:opacity-40" />
            </label>
          </>
        )}
        {cfg.who === "solver" && (
          <>
            <select value={cfg.budgetMs} onChange={(e) => onCfg({ ...cfg, budgetMs: Number(e.target.value) })} aria-label="think budget" className="rounded bg-zinc-900 px-1 py-0.5 text-zinc-100">
              {BUDGETS.map((b) => <option key={b} value={b}>think {b}ms</option>)}
            </select>
            <label className="flex items-center gap-1" title="Off: the solver also uses which pieces are left in the current 7-bag (public, but only it uses it)">
              <input type="checkbox" checked={cfg.strictInfo} onChange={(e) => onCfg({ ...cfg, strictInfo: e.target.checked })} /> strict info
            </label>
          </>
        )}
      </div>
    </div>
  );
}

export const Board = memo(function Board({ index, cfg, onCfg, engine, seed, running, actionMs, onStatus }: {
  index: number; cfg: BoardCfg; onCfg: (i: number, c: BoardCfg) => void; engine: EngineConfig; seed: number;
  running: boolean; actionMs: number; onStatus: (i: number, s: Status) => void;
}) {
  const simRef = useRef<Sim | null>(null);
  const [view, setView] = useState<View>(() => viewOf(createSim(engine, seed, cfg.advanced)));
  const live = useRef({ cfg, actionMs, onStatus }); // latest props for the frame loop; changes apply from the next piece
  useEffect(() => { live.current = { cfg, actionMs, onStatus }; });

  useEffect(() => {
    if (!running) return;
    const s = (simRef.current ??= createSim(engine, seed, live.current.cfg.advanced));
    let raf = 0, last = performance.now(), key = "";
    const frame = (now: number) => {
      const { cfg: c, actionMs: am, onStatus: report } = live.current;
      const events = advance(s, Math.min(now - last, 250), am);
      last = now;
      if (needsDecision(s)) {
        s.advanced = c.advanced;
        const ctl = new AbortController();
        const ctx = begin(s, ctl);
        const t0 = performance.now();
        controllerFor(c, WEB)(ctx, ctl.signal).then(
          (d) => deliver(s, ctx.pieceId, d, performance.now() - t0),
          (e) => { if (!ctl.signal.aborted) fail(s, ctx.pieceId, (e as Error).message); },
        );
      }
      const v = viewOf(s);
      if (v.key !== key) { key = v.key; setView(v); }
      if (events.length) { // every top-out happens inside a lock, so locks are the only status changes
        report(index, { score: s.game.score, lines: s.game.lines, pieces: s.game.pieces, level: s.game.level, over: s.game.over, overAt: s.overAt });
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); cancel(s); };
  }, [running, engine, seed, index]);

  const v = view;
  const stats: [string, string | number][] = [
    ["score", v.score], ["lines", v.lines], ["level", v.level], ["pieces", v.pieces],
    ["T-spins", v.tspins], ["Tetrises", v.tetrises], ["late", v.stats.late], ["avg ms", Math.round(v.stats.avgMs)],
  ];
  return (
    <section className="flex w-full max-w-[320px] flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h2 className="font-mono text-lg font-bold">{label(cfg)}</h2>
        <span className={`font-mono text-xs ${v.phase === "thinking" ? "text-sky-300" : v.phase === "moving" ? "text-amber-300" : "text-zinc-500"}`}>{v.phase}</span>
      </div>
      <Picker cfg={cfg} onCfg={(c) => onCfg(index, c)} disabled={false} />
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Grid board={v.board} flash={v.flash} flashKind={v.flashKind} />
          <Overlay view={v} />
          {v.phase === "over" && (
            <div className="absolute inset-0 grid place-items-center bg-black/70 font-mono text-xl font-bold text-red-400">TOPPED OUT</div>
          )}
        </div>
        <div className="flex w-14 flex-col items-center gap-2 font-mono text-[10px] text-zinc-500">
          <span>next</span>
          <Preview piece={v.next} />
          {v.garbageInMs !== null && <span className="mt-2 text-center">garbage in <b className="text-zinc-300">{(v.garbageInMs / 1000).toFixed(1)}s</b></span>}
          {v.garbageQueued > 0 && <span className="text-center text-red-300" title="rows pushed in when the current piece locks">queued <b>{v.garbageQueued}</b></span>}
          {v.stats.fallbacks > 0 && <span className="text-center">fallbacks <b className="text-zinc-300">{v.stats.fallbacks}</b></span>}
          {v.stats.missed > 0 && <span className="text-center" title="decided in time, but the lock delay ran out mid-move">missed <b className="text-zinc-300">{v.stats.missed}</b></span>}
          {v.stats.errors > 0 && <span className="text-center text-red-400">errors <b>{v.stats.errors}</b></span>}
          {v.stats.assists > 0 && <span className="text-center">assists <b className="text-zinc-300">{v.stats.overrides}/{v.stats.assists}</b></span>}
        </div>
      </div>
      <dl className="grid grid-cols-4 gap-1 text-center font-mono">
        {stats.map(([k, val]) => (
          <div key={k} className="rounded bg-zinc-900 py-0.5">
            <dt className="text-[9px] uppercase text-zinc-500">{k}</dt>
            <dd className="text-sm">{val}</dd>
          </div>
        ))}
      </dl>
      <Panel view={v} cfg={cfg} />
    </section>
  );
});
