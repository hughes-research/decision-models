// Chiptune Korobeiniki (the 19th-century Russian folk tune behind the Tetris theme; public domain),
// synthesised live with Web Audio: square-wave lead, triangle bass, kick and hi-hat. No audio files.
// A look-ahead scheduler queues notes slightly ahead of time; setRate() speeds the tempo up smoothly.

type Note = [string | null, number]; // [pitch like "E5" or null for a rest, length in eighth notes]

// Section A (8 bars) twice, then section B (8 bars).
const A: Note[] = [
  ["E5", 2], ["B4", 1], ["C5", 1], ["D5", 2], ["C5", 1], ["B4", 1],
  ["A4", 2], ["A4", 1], ["C5", 1], ["E5", 2], ["D5", 1], ["C5", 1],
  ["B4", 3], ["C5", 1], ["D5", 2], ["E5", 2],
  ["C5", 2], ["A4", 2], ["A4", 2], [null, 2],
  [null, 1], ["D5", 2], ["F5", 1], ["A5", 2], ["G5", 1], ["F5", 1],
  ["E5", 3], ["C5", 1], ["E5", 2], ["D5", 1], ["C5", 1],
  ["B4", 2], ["B4", 1], ["C5", 1], ["D5", 2], ["E5", 2],
  ["C5", 2], ["A4", 2], ["A4", 2], [null, 2],
];
const B: Note[] = [
  ["E5", 4], ["C5", 4], ["D5", 4], ["B4", 4], ["C5", 4], ["A4", 4], ["G#4", 4], ["B4", 4],
  ["E5", 4], ["C5", 4], ["D5", 4], ["B4", 4], ["C5", 2], ["E5", 2], ["A5", 4], ["G#5", 8],
];
const MELODY = [...A, ...A, ...B];
// One bass root per bar (8 eighths), bouncing between octaves.
const BASS_A = ["E2", "A2", "G#2", "A2", "D2", "C2", "E2", "A2"];
const BASS_B = ["A2", "E2", "A2", "E2", "A2", "E2", "A2", "E2"];
const BASS = [...BASS_A, ...BASS_A, ...BASS_B];

const NAMES: Record<string, number> = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
const freq = (n: string) => {
  const m = /^([A-G]#?)(\d)$/.exec(n)!;
  return 440 * Math.pow(2, (NAMES[m[1]] + 12 * (Number(m[2]) + 1) - 69) / 12);
};

// Melody laid out on an eighth-note grid: step -> [frequency, length in steps].
const LEAD = new Map<number, [number, number]>();
let pos = 0;
for (const [n, len] of MELODY) { if (n) LEAD.set(pos, [freq(n), len]); pos += len; }
const STEPS = pos; // 192 eighths: 24 bars (A, A, B)

const BASE_EIGHTH = 60 / 150 / 2; // 150 BPM
const VOLUME = 0.22;

export class Music {
  private ctx = new AudioContext(); // create from a user gesture (the Start button)
  private master = this.ctx.createGain();
  private noise: AudioBuffer;
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private next = 0;
  private rate = 1;

  constructor() {
    this.master.gain.value = VOLUME;
    this.master.connect(this.ctx.destination);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate / 2, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  play() {
    void this.ctx.resume();
    if (this.timer) return;
    this.next = Math.max(this.next, this.ctx.currentTime + 0.05);
    this.timer = setInterval(() => this.schedule(), 25);
  }

  pause() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.ctx.suspend();
  }

  stop() {
    this.pause();
    this.step = 0;
    this.next = 0;
  }

  setRate(r: number) { this.rate = Math.min(2.2, Math.max(1, r)); }

  setMuted(m: boolean) { this.master.gain.setTargetAtTime(m ? 0 : VOLUME, this.ctx.currentTime, 0.03); }

  private schedule() {
    const eighth = BASE_EIGHTH / this.rate;
    while (this.next < this.ctx.currentTime + 0.12) {
      this.playStep(this.step, this.next, eighth);
      this.next += eighth;
      this.step = (this.step + 1) % STEPS;
    }
  }

  private playStep(step: number, t: number, eighth: number) {
    const lead = LEAD.get(step);
    if (lead) this.tone("square", lead[0], t, lead[1] * eighth * 0.92, 0.11);
    const bar = Math.floor(step / 8);
    const root = freq(BASS[bar % BASS.length]);
    this.tone("triangle", step % 2 ? root * 2 : root, t, eighth * 0.85, 0.3);
    if (step % 4 === 0) this.kick(t);
    this.hat(t, step % 2 ? 0.05 : 0.025);
  }

  private tone(type: OscillatorType, f: number, t: number, dur: number, vol: number) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.setValueAtTime(vol * 0.7, t + Math.min(0.05, dur / 2));
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private kick(t: number) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.45, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.15);
  }

  private hat(t: number, vol: number) {
    const src = this.ctx.createBufferSource(), hp = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    src.buffer = this.noise;
    hp.type = "highpass";
    hp.frequency.value = 7000;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    src.connect(hp).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.4);
    src.stop(t + 0.05);
  }
}
