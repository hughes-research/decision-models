"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Board, TileDefs, type Status } from "./Board";
import { Clock } from "./Clock";
import { Music } from "./music";
import { LINEUP, label, type BoardCfg } from "@/lib/controllers";
import type { EngineConfig } from "@/lib/engine";

const SPEEDS = [{ name: "slow", ms: 160 }, { name: "normal", ms: 80 }, { name: "fast", ms: 30 }];

type Settings = { seed: number; minutes: number; gravity: boolean; startLevel: number; garbage: boolean; garbageSecs: number };
const DEFAULTS: Settings = { seed: 42, minutes: 3, gravity: true, startLevel: 1, garbage: true, garbageSecs: 6 };

export default function Home() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [lineup, setLineup] = useState<BoardCfg[]>(LINEUP);
  const [actionMs, setActionMs] = useState(80);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState(0);
  const [remaining, setRemaining] = useState(DEFAULTS.minutes * 60_000);
  const [status, setStatus] = useState<(Status | undefined)[]>([]);
  const music = useRef<Music | null>(null); // created on the first Start click (browsers only allow audio after a gesture)
  const [muted, setMuted] = useState(false);

  const engine = useMemo<EngineConfig>(() => ({
    gravity: settings.gravity, startLevel: settings.startLevel, garbageMs: settings.garbage ? settings.garbageSecs * 1000 : 0, lockDelayMs: 500,
  }), [settings.gravity, settings.startLevel, settings.garbage, settings.garbageSecs]);

  const onStatus = useCallback((i: number, s: Status) => setStatus((prev) => { const n = [...prev]; n[i] = s; return n; }), []);
  const onCfg = useCallback((i: number, c: BoardCfg) => setLineup((prev) => prev.map((x, k) => (k === i ? c : x))), []);

  const alive = lineup.filter((_, i) => !status[i]?.over).length;
  const finished = remaining <= 0 || alive === 0;
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

  useEffect(() => {
    const m = music.current;
    if (!m) return;
    if (active) m.play();
    else if (finished) m.stop();
    else m.pause();
  }, [active, finished]);

  // Tempo follows difficulty: the highest level any live board has reached, plus how far into the race we are.
  const maxLevel = Math.max(settings.startLevel, ...status.filter((s) => s && !s.over).map((s) => s!.level));
  const progress = 1 - remaining / (settings.minutes * 60_000);
  useEffect(() => {
    music.current?.setRate(1 + 0.06 * (maxLevel - 1) + 0.35 * progress + (remaining <= 10_000 ? 0.15 : 0));
  }, [maxLevel, progress, remaining]);

  useEffect(() => { music.current?.setMuted(muted); }, [muted]);

  // A hidden tab stops animation frames but not network requests, which would hand slow controllers free time.
  useEffect(() => {
    const onHide = () => { if (document.hidden) setRunning(false); };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  const reset = (next: Settings = settings) => {
    music.current?.stop();
    setRunning(false);
    setRunId((n) => n + 1);
    setStatus([]);
    setRemaining(next.minutes * 60_000);
  };
  const change = (patch: Partial<Settings>) => { const next = { ...settings, ...patch }; setSettings(next); reset(next); };

  // Survival first (a later top-out beats an earlier one), then score. Garbage is time-based, so every board
  // faces the same rows per minute whatever its pace, and outlasting the others is the real test.
  const podium = finished
    ? lineup.map((c, i) => ({ name: label(c), s: status[i] }))
      .sort((a, b) => (b.s?.over ? b.s.overAt ?? 0 : Infinity) - (a.s?.over ? a.s.overAt ?? 0 : Infinity) || (b.s?.score ?? 0) - (a.s?.score ?? 0))
    : null;
  const input = "rounded bg-zinc-900 px-2 py-1";

  return (
    <main className="flex min-h-screen flex-col items-center gap-5 bg-black px-4 py-6 text-zinc-100">
      <TileDefs />
      <header className="text-center">
        <h1 className="font-mono text-4xl font-bold tracking-tight">Decision model vs heuristic vs OR solver</h1>
        <p className="mt-1 text-base text-zinc-400">Same pieces, same garbage on the same clock. Pieces fall while each controller thinks; a slow answer means the piece lands where gravity takes it.</p>
      </header>

      {/* Buttons stay centred; the clock sits on the right. */}
      <div className="grid w-full max-w-5xl grid-cols-[1fr_auto_1fr] items-center gap-3 font-mono text-sm">
        <div />
        <div className="flex gap-3">
          <button onClick={() => { music.current ??= new Music(); music.current.setMuted(muted); setRunning((r) => !r); }} disabled={finished}
            className="rounded bg-green-600 px-4 py-2 font-bold hover:bg-green-500 disabled:opacity-40">
            {active ? "Pause" : "Start"}
          </button>
          <button onClick={() => reset()} className="rounded bg-zinc-700 px-4 py-2 hover:bg-zinc-600">Reset</button>
          <button onClick={() => setMuted((m) => !m)} aria-pressed={!muted} title="Tetris music (speeds up as the game gets harder)"
            className="rounded bg-zinc-800 px-3 py-2 text-zinc-300 hover:bg-zinc-700">{muted ? "♪ off" : "♪ on"}</button>
        </div>
        <div className="justify-self-end"><Clock ms={remaining} urgent={active && remaining <= 10_000} /></div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 font-mono text-sm text-zinc-300">
        <label className="flex items-center gap-1">seed
          <input type="number" defaultValue={settings.seed} disabled={active} onChange={(e) => { const v = e.target.valueAsNumber; if (Number.isInteger(v)) change({ seed: v }); }} className={`w-16 ${input}`} />
        </label>
        <label className="flex items-center gap-1">minutes
          <input type="number" min={1} max={60} defaultValue={settings.minutes} disabled={active} onChange={(e) => { const v = e.target.valueAsNumber; if (v >= 1 && v <= 60) change({ minutes: v }); }} className={`w-14 ${input}`} />
        </label>
        <label className="flex items-center gap-1" title="Off = the turn-based race: the piece waits at the top for its controller">
          <input type="checkbox" checked={settings.gravity} disabled={active} onChange={(e) => change({ gravity: e.target.checked })} /> real-time gravity
        </label>
        <label className="flex items-center gap-1" title="Gravity speeds up every 10 lines">start level
          <input type="number" min={1} max={15} defaultValue={settings.startLevel} disabled={active} onChange={(e) => { const v = e.target.valueAsNumber; if (Number.isInteger(v) && v >= 1 && v <= 15) change({ startLevel: v }); }} className={`w-12 ${input}`} />
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={settings.garbage} disabled={active} onChange={(e) => change({ garbage: e.target.checked })} /> rising garbage every
          <input type="number" min={1} max={60} step={0.5} defaultValue={settings.garbageSecs} disabled={active || !settings.garbage} onChange={(e) => { const v = e.target.valueAsNumber; if (v >= 1 && v <= 60) change({ garbageSecs: v }); }} className={`w-14 ${input} disabled:opacity-40`} />
          seconds
        </label>
        <label className="flex items-center gap-1" title="How fast pieces move once a decision arrives (it costs game time: gravity keeps running)">moves
          <select value={actionMs} onChange={(e) => setActionMs(Number(e.target.value))} className={input}>
            {SPEEDS.map((s) => <option key={s.ms} value={s.ms}>{s.name} ({s.ms}ms)</option>)}
          </select>
        </label>
      </div>

      {podium && (
        <ol className="flex flex-wrap justify-center gap-3 font-mono">
          {podium.map((p, i) => (
            <li key={p.name + i} className={`rounded-lg px-4 py-2 ${i === 0 ? "bg-yellow-400 font-bold text-black" : "bg-zinc-800"}`}>
              {i + 1}. {p.name} · {p.s?.score ?? 0}{p.s?.over ? ` · topped out at ${((p.s.overAt ?? 0) / 1000).toFixed(0)}s` : ""}
            </li>
          ))}
        </ol>
      )}

      <div className="flex w-full flex-wrap justify-center gap-6">
        {lineup.map((cfg, i) => (
          <Board key={`${i}-${runId}`} index={i} cfg={cfg} onCfg={onCfg} engine={engine} seed={settings.seed}
            running={active} actionMs={actionMs} onStatus={onStatus} />
        ))}
      </div>
    </main>
  );
}
