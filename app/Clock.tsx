// Old-school seven-segment countdown clock, drawn as vector segments.
const HX = 1.1; // half thickness of a segment
const hor = (y: number) => `2.4,${y} ${2.4 + HX},${y - HX} ${9.6 - HX},${y - HX} 9.6,${y} ${9.6 - HX},${y + HX} ${2.4 + HX},${y + HX}`;
const ver = (x: number, y1: number, y2: number) => `${x},${y1} ${x + HX},${y1 + HX} ${x + HX},${y2 - HX} ${x},${y2} ${x - HX},${y2 - HX} ${x - HX},${y1 + HX}`;
// Segments a..g in a 12 x 22 cell.
const SEG = [hor(1.5), ver(10.5, 2.4, 10.2), ver(10.5, 11.8, 19.6), hor(20.5), ver(1.5, 11.8, 19.6), ver(1.5, 2.4, 10.2), hor(11)];
const DIGITS = ["abcdef", "bc", "abged", "abgcd", "fgbc", "afgcd", "afgedc", "abc", "abcdefg", "abfgcd"];

function Digit({ d, x }: { d: number; x: number }) {
  const on = DIGITS[d];
  return (
    <g transform={`translate(${x} 0) skewX(-6)`}>
      {SEG.map((pts, i) => (
        <polygon key={i} points={pts} fill={on.includes("abcdefg"[i]) ? "#ff3030" : "#2b0b0b"} />
      ))}
    </g>
  );
}

export function Clock({ ms, urgent }: { ms: number; urgent: boolean }) {
  const secs = Math.ceil(ms / 1000);
  const m = Math.min(99, Math.floor(secs / 60)), s = secs % 60;
  const colon = secs % 2 === 0 || ms <= 0; // blinks every second
  return (
    <div role="timer" aria-label={`${m} minutes ${s} seconds left`}
      className="rounded-lg border-2 border-zinc-700 bg-black px-3 py-2 shadow-[inset_0_0_12px_rgba(0,0,0,0.9),0_0_0_3px_#18181b]">
      <svg viewBox="0 0 62 22" className={`h-10 w-auto drop-shadow-[0_0_5px_rgba(255,48,48,0.75)] ${urgent ? "animate-pulse" : ""}`}>
        <Digit d={Math.floor(m / 10)} x={0} />
        <Digit d={m % 10} x={13} />
        <circle cx={30.4} cy={7} r={1.3} fill={colon ? "#ff3030" : "#2b0b0b"} />
        <circle cx={29.6} cy={15} r={1.3} fill={colon ? "#ff3030" : "#2b0b0b"} />
        <Digit d={Math.floor(s / 10)} x={35} />
        <Digit d={s % 10} x={48} />
      </svg>
    </div>
  );
}
