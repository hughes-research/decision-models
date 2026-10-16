# Heuristic assist for Clef and Clef-flash: experiment results

**Question:** when a decision model can't make up its mind on a Tetris move, can a heuristic, or a blend of the model and a heuristic, pick better? Can the model's own judgments teach us better heuristics?

**Short answer:** yes for flash, and probably for clef.
- **Both models are nearly always undecided.** Median confidence is 0.020 for flash and 0.077 for clef.
- **Both have a measurable blind spot:** they dig holes they could avoid.
- **Flash, offline:** the best assists cut regret by about two-thirds (17.2 → 5.7; lookahead vs flash 95% CI [−15.9, −7.4]).
- **Flash, live:** over 3 seeds, holes after 50 pieces drop from 26 to 0 and the score triples.
- **Clef:** the offline gain (9.7 → 7.0) points the same way, but at 50 states the interval includes zero (95% CI [−6.7, +1.0]).
- **Learning from the model:** clef's own board ratings, with the missing hole penalty added back, became the best live assist.

All numbers below were recomputed after an adversarial review (5 reviewers, 2 skeptics per finding). That review corrected method counts, a stale table row, three overclaims, and two method bugs: `lee4` scored boards after line clears instead of before, and `borda` was given a fake model vote in the no-model benchmark.

## Setup

- **Moves:** each move offers up to 26 hard-drop placements as one `choice` question (`lib/prompt.ts`).
- **Assist:** the method steps in only when the model's `confidence` is below the gate (`app/page.tsx`, `scripts/live.ts`).
- **Data collected from the models** (`scripts/collect.ts`, in `experiments/data/`):
  - 150 boards rated 0–4 for health by clef;
  - 97 flash move decisions and 50 clef move decisions on sampled states.
- **Three ways to evaluate:**
  1. **Heuristic only** (`scripts/bench.ts`): every method plays seeds 1–5 for up to 500 pieces, with no model.
  2. **Offline** (`scripts/offline.ts`): the real model probabilities replayed against a Monte Carlo oracle, with 12 rollouts × depth 8 per option. The oracle's rollout policy is Dellacherie, so it favours Dellacherie-like play.
  3. **Live** (`scripts/live.ts`): flash plays 50 pieces on seeds 3, 4 and 5 with each assist. This is the check the oracle can't bias.
- **Metrics:**
  - **Regret:** oracle value of the best option minus that of the option picked. Lower is better.
  - **Oracle-best:** % of picks that match the oracle's best option.
  - **Hole blunder:** a pick that creates a new hole when another option doesn't.
- **Random baseline** (uniform pick), flash / clef:
  - regret 45.6 / 41.9;
  - oracle-best 8% / 8%;
  - hole blunders 71% / 76%.

## The 22 methods

Five are classics from Tetris AI research. The other 17 are new: 4 original heuristics, 3 learned from the models' own judgments, and 10 model + heuristic fusion rules. All 22 are in the picker on each board.

| Kind | Method | Idea |
|---|---|---|
| Classic | `lee4` | Lee's GA-tuned 4 features (height, lines, holes, bumpiness), measured after the piece lands and before rows clear, as in his reference AI |
| Classic | `dellacherie` | 6 features with El-Tetris PSO weights |
| Classic | `holes-first` | Strict priority: holes, then height, then bumpiness |
| Classic | `transitions` | Fewest row/column filled-empty transitions |
| Classic | `lookahead` | Dellacherie plus the best follow-up for the known next piece |
| Original | `well-keeper` | Keeps the right column as a well; saves rows for Tetrises while the stack is low |
| Original | `danger-adaptive` | Slides from well-keeping to pure survival as the stack rises |
| Original | `contour` | Rewards pieces that touch the stack on many sides (jigsaw fit) |
| Original | `rollout` | Monte Carlo: top 5 candidates × 6 random futures × depth 4 |
| Learned | `clef-distilled` | Ridge regression of clef's board ratings on board features |
| Learned | `clef-hole-sense` | Clef-distilled plus the hole penalty clef turned out to lack (weight 2) |
| Learned | `move-distilled` | Softmax regression on the models' move distributions, plus lookahead |
| Fusion | `poe` | log p(model) + z(Dellacherie), equal weight |
| Fusion | `poe-tuned` | log p(model) + β·z(lookahead), with β = 5 chosen offline |
| Fusion | `entropy-gate` | Mixes the model and lookahead by the model's normalized entropy |
| Fusion | `shortlist` | Lookahead's top 3; the model picks among them |
| Fusion | `perplexity-shortlist` | Shortlist size = e^entropy of the model (its effective number of choices); lookahead picks within it |
| Fusion | `veto` | The model's pick stands unless lookahead rates it below average |
| Fusion | `hole-guard` | The model's pick stands unless it digs an avoidable hole |
| Fusion | `reliability-rank` | Rank fusion weighted by each source's measured Spearman agreement with the oracle |
| Fusion | `borda` | Rank vote across 5 heuristics and the model |
| Fusion | `minimax-regret` | Picks the option whose worst regret across a committee is smallest |

## What the models taught us

1. **Once height is accounted for, clef gives holes no penalty.** Holes do correlate with clef's rating on their own (r = −0.58), but only because they come with height: their correlation with aggregate height is 0.82.
   - At equal height, the partial correlation of holes with clef's rating is **+0.32**, so more holes earn a slightly *higher* rating.
   - The ridge fit (R² = 0.77) says the same: aggregate height −0.47, max height −0.19, holes +0.06 (standardized).
   - Used directly as a heuristic, `clef-distilled` dies in about 106 pieces with 15 holes on average.
   - Adding the hole penalty back (`clef-hole-sense`) makes it survive 500 pieces on 5 of 5 seeds.
   - At hole weight 1 it survived 2 of 5 seeds. Roughly 1.1 to 4 all survive. Weight 2 was kept; heavier weights leave fewer holes, so much of the gain comes from the explicit hole term.
2. **Flash's distribution is nearly flat, but its top pick isn't random.**
   - Mean normalized entropy is 0.98, and it puts 73% of its probability on hole-digging options against 75% for a uniform guess.
   - Its top pick still beats random by far (oracle-best 32% vs 8%, regret 17.2 vs 45.6), but it digs an avoidable hole on 47% of moves (random: 71%).
   - The shipped move fit pools 97 flash and 22 clef decisions (n = 119): cross-entropy 2.81 against 2.86 for uniform. Holes are its largest weight (−0.89 standardized).
3. **The models carry real signal.** Spearman ρ between the model's probabilities and the oracle:
   - flash 0.44, clef 0.51;
   - for comparison, lookahead gets 0.69 and 0.73.

   The ranking is informative; the top pick isn't reliable.
4. **The gate needs a scale per model.** A fixed 0.15 gate means "always assist" for flash.
   - Offline, more assistance was always better for flash (see the gating table).
   - The UI defaults (0.025 for flash, 0.1 for clef) assist on roughly two-thirds of moves, which leaves the model in charge of its most confident third. Set the gate to 1 for always-on.

## Heuristic-only benchmark (no model; 5 seeds, cap 500 pieces)

500 pieces is the cap, so "survived 5/5" means a method reached the cap on every seed.

| Method | Pieces | Score | Tetrises | Survived | Avg holes |
|---|---|---|---|---|---|
| well-keeper | 500 | **26060** | **4.4** | 5/5 | 0.48 |
| danger-adaptive | 500 | 25620 | 3.0 | 5/5 | 0.57 |
| rollout | 500 | 23620 | 0.2 | 5/5 | 0.16 |
| lookahead | 500 | 23140 | 0 | 5/5 | **0.03** |
| borda | 500 | 22800 | 0 | 5/5 | 0.12 |
| minimax-regret | 500 | 22560 | 0.2 | 5/5 | 0.10 |
| dellacherie | 500 | 22480 | 0 | 5/5 | 0.24 |
| contour | 500 | 22100 | 0.2 | 5/5 | 0.66 |
| clef-hole-sense | 500 | 22040 | 0.2 | 5/5 | 2.22 |
| lee4 | 500 | 22000 | 0.2 | 5/5 | 2.65 |
| move-distilled | 500 | 21680 | 0 | 5/5 | 0.39 |
| holes-first | 435 | 22000 | 3.2 | 4/5 | 2.05 |
| transitions | 293 | 13240 | 2.2 | 1/5 | 3.94 |
| clef-distilled | 106 | 2680 | 0 | 0/5 | 15.1 |

The fusions that use lookahead (`entropy-gate`, `poe-tuned`, `perplexity-shortlist`, `shortlist`) reduce to lookahead without a model opinion, and play identically. Hole guard, veto and reliability-rank need the model's opinion, so a no-model run says nothing about them.

## Offline: real model decisions, method used on every move (gate = 1)

| | flash regret | flash best | flash blunders | clef regret | clef best | clef blunders |
|---|---|---|---|---|---|---|
| random pick | 45.56 | 8% | 71% | 41.86 | 8% | 76% |
| **model alone** | 17.22 | 32% | 47% | 9.72 | 38% | 30% |
| entropy-gate | **5.73** | 54% | 7% | 7.43 | 42% | 12% |
| lookahead | 5.75 | 52% | 6% | **7.00** | 42% | 14% |
| perplexity-shortlist | 5.75 | 52% | 6% | **7.00** | 42% | 14% |
| poe-tuned | 5.77 | 54% | 7% | 7.19 | 42% | 12% |
| move-distilled | 6.08 | **55%** | 13% | 8.79 | 34% | 20% |
| rollout | 6.36 | 51% | 18% | 7.40 | 34% | 26% |
| dellacherie | 8.30 | 46% | 6% | 8.53 | 40% | 10% |
| poe | 8.62 | 45% | 11% | 8.52 | 42% | 12% |
| borda | 9.30 | 45% | 11% | 9.04 | 36% | 8% |
| reliability-rank | 10.01 | 38% | 22% | 7.78 | **44%** | 12% |
| minimax-regret | 10.11 | 40% | 24% | 8.83 | 40% | 8% |
| clef-hole-sense | 11.76 | 43% | 12% | 8.92 | 40% | 16% |
| hole-guard | 13.64 | 37% | **0%** | 9.53 | 36% | **0%** |
| veto | 14.41 | 34% | 41% | 9.04 | 38% | 28% |
| clef-distilled | 21.01 | 25% | 57% | 25.75 | 18% | 62% |

**Flash vs lookahead:** lookahead beats flash's pick on 46 states, loses on 12, and the rest are ties. The regret change is −11.5, 95% CI [−15.9, −7.4].

**Clef vs lookahead:** lookahead wins 14 and loses 11. The regret change is −2.7, 95% CI [−6.7, +1.0]: suggestive, not significant.

**Gating, flash with lookahead.** Regret falls steadily as the gate opens:

| Gate | Moves assisted | Regret |
|---|---|---|
| no assist | 0% | 17.2 |
| < 0.015 | 21% | 13.7 |
| < 0.02 | 46% | 10.4 |
| < 0.025 | 68% | 8.7 |
| < 0.03 | 85% | 7.1 |
| always | 100% | 5.75 |

## Live games: flash with the assist on every move (50 pieces, seeds 3, 4 and 5)

| Assist | Mean score | Scores per seed | Lines | Holes at end | Max height | Overrides (of 50) |
|---|---|---|---|---|---|---|
| none (flash alone) | 767 | 600 / 900 / 800 | 7.3 | 26.3 | 17.3 | 0 |
| **clef-hole-sense** | **2367** | 2400 / 2300 / 2400 | 18.7 | 0 | 3.0 | 25.7 |
| entropy-gate | 2167 | 2200 / 2300 / 2000 | 18.3 | 0 | 4.3 | 27.7 |
| poe-tuned | 2167 | 2300 / 2000 / 2200 | 18.7 | 0 | 3.3 | 25.3 |
| lookahead | 2067 | 1800 / 2100 / 2300 | 18.3 | 0 | 4.0 | 27.7 |
| move-distilled | 1967 | 1800 / 2100 / 2000 | 18.7 | 0 | 3.0 | 29.0 |
| hole-guard | 1767 | 1200 / 2200 / 1900 | 14.3 | 2.0 | 9.7 | 24.7 |
| lookahead, gated at 0.025 | 1667 | 1600 / 1600 / 1800 | 14.7 | 5.7 | 7.3 | 20.0 of 28.3 assisted |

- **Flash alone** ends every 50-piece game with 19–35 holes and a stack 16–19 rows high, close to topping out.
- **Every always-on assist** except hole guard ends with 0 holes and a stack 2–6 rows high.
- **The leaders are close.** The top four differ by 300 points, which is 1–2 line clears on 3 short games, so the ranking among them is suggestive.
- **Live and offline disagree about clef-hole-sense.** It was the most consistent live (2300–2400), even though the Dellacherie-based oracle rated it only mid-table. That is a reminder of the oracle's bias.

## Takeaways

- **What works best:**
  - Lookahead-based assists are strongest on every measure.
  - The clef-learned `clef-hole-sense` did best live.
  - For points rather than survival, `well-keeper` scores most (4.4 Tetrises per game).
- **Fusion adds nothing measurable over lookahead.**
  - Entropy-gate changes 2 of 97 flash picks (−0.03 regret) and poe-tuned is level (5.77 vs 5.75). For clef, both are slightly worse.
  - `perplexity-shortlist` picks the same option as lookahead on every state, because e^entropy covers most options and the list always includes lookahead's favourite.
  - The β curve is flat from about 5 upward for flash and noisy for clef, so no confidence-to-β rule can be read from it. The model's 26-way distribution is too flat to do more than break ties.
- **Rules that trust the model's argmax do badly.** Veto and shortlist inherit its blunders.
  - Hole guard removes every avoidable hole (0% blunders) but nothing else, so its regret stays high.
- **Learning from the model works as diagnosis, not imitation.** Copying clef's ratings fails, and those ratings revealed exactly what it misses. Adding an explicit hole penalty fixed survival, and that version was the best live assist. On the oracle's own terms, though, it still trails plain Dellacherie.

## Reproduce

```bash
node --no-warnings scripts/collect.ts 150 100 50   # model judgments → experiments/data (about 20 min)
POE_BETA=5 node --no-warnings scripts/fit.ts       # → lib/learned.ts
node --no-warnings scripts/bench.ts 5 500          # heuristic-only leaderboard
node --no-warnings scripts/offline.ts clef-flash 0.015 0.02 0.025 0.03 1
node --no-warnings scripts/live.ts clef-flash 50 3 off lookahead@1 entropy-gate@1
npm test
```

---

# Part 2: three kinds of controller at hard-mode Tetris

**Question:** under real pressure, how do a decision model (clef / clef-flash), the best heuristics and a purpose-built operations-research (OR) solver compare?

**Short answer:**
- **The OR solver wins whenever the game is hard, and it isn't close.** Under garbage every 5 pieces it survived 3 minutes in 6 of 8 games; the best heuristic survived none.
- **When the game is easy, speed wins on score.** At garbage every 8 pieces everything strong survives, and the instant heuristic places more pieces and scores more.
- **The decision models are out of their depth under real-time gravity.** clef-flash topped out in every game at about 83s with under 1,000 points.

## What changed in the game

- **Real-time gravity.** The piece keeps falling while its controller thinks. If it lands, it locks after a 500ms lock delay wherever it is.
- **SRS rotation with wall kicks.** That adds **tucks** (last-second slides under an overhang) and **T-spins**, scored by guideline points. Both are a per-board "advanced moves" switch.
- **Rising garbage.** Every N pieces a row with one gap pushes the stack up, the same rows on every board.
- **Speed levels.** Gravity follows the guideline curve and speeds up every 10 lines.

Decisions play out visibly, one move at a time (80ms per move, soft drops 20ms per row), and gravity keeps running while they do.

## The OR solver (`or-solver/`, Python, port 8100)

It uses rolling-horizon planning: plan 5–6 pieces ahead, play only the first placement, then re-plan.

- **Root moves:** every lock reachable now, including tucks and spins.
- **Hard constraints:** no new sealed holes, a height cap, and a clear spawn area, loosened in that order only when nothing passes.
- **Scoring:** placements are scored with Dellacherie's evaluator plus spin and Tetris bonuses while the stack is safe. A plan scores the sum of its placements.
- **Search:**
  1. An exact stage over the current and next piece. On its own this equals the lookahead heuristic.
  2. The bag knowledge: the pieces left in the current 7-bag are known, their order isn't. Orders are enumerated when few, otherwise sampled.
  3. A beam search per scenario, with successive halving under a time limit.
- **Timing:** the limit is scaled to the fall time, so it thinks less at high gravity.
- **One set of rules:** they live in the TypeScript engine and are exported to Python (`scripts/fixtures.ts`). 257 parity tests check that both engines agree.

## Results (`scripts/race.ts`; 3 minutes; seeds 1–8, models seeds 1–3; latency measured for real)

**Survival** and mean time survived (3 minutes = survived):

| Garbage every | OR solver + advanced | OR solver | OR + advanced, no bag info | Lookahead | Dellacherie | Well-keeper | clef-flash | clef* |
|---|---|---|---|---|---|---|---|---|
| 8 pieces | 8/8 | 8/8 | 8/8 | 8/8 | 2/8 · 149s | 0/8 · 113s | 0/3 · 83s | 3/3 |
| 5 pieces | **6/8 · 179s** | 2/8 · 165s | 4/8 · 175s | 0/8 · 134s | 0/8 · 86s | 0/8 · 55s | 0/3 · 83s | 3/3 |
| 3 pieces | **97s** | 87s | 80s | 59s | 40s | 32s | — | — |

**Mean score:**

| Garbage every | OR solver + advanced | OR solver | OR + advanced, no bag info | Lookahead | Dellacherie | Well-keeper | clef-flash | clef* |
|---|---|---|---|---|---|---|---|---|
| 8 pieces | 87,925 | 92,850 | 95,963 | **121,625** | 88,925 | 54,363 | 433 | 567 |
| 5 pieces | **123,238** | 100,688 | 109,775 | 81,138 | 33,550 | 12,925 | 700 | 800 |
| 3 pieces | **45,675** | 35,725 | 28,650 | 19,975 | 7,025 | 4,063 | — | — |

**Paired survival difference against lookahead** (95% bootstrap CI over seeds):

| Garbage every | OR solver + advanced | OR solver | OR + advanced, no bag info |
|---|---|---|---|
| 5 pieces | **+44s [33, 58]** | +31s [6, 52] | +40s [25, 58] |
| 3 pieces | **+38s [27, 52]** | +28s [10, 46] | +21s [1, 41] |

T-spins per game for OR solver + advanced: 3.0 at garbage 8, 2.9 at garbage 5, 1.8 at garbage 3. The heuristics, which can't plan spins, made none.

\* clef "survives" only because it is slow. It places about 26 pieces in 3 minutes (about 6s per move), and garbage comes per piece placed, so it faces only 3–5 garbage rows. Its score shows how it really played. This is also why the page ranks the podium by score, not survival.

## What it shows

1. **Under pressure the OR solver dominates.** At garbage every 5 and every 3 it outlives the best heuristic by 38–44s, with confidence intervals well clear of zero. It scores 1.5–2.3× more, and is the only controller that survives at garbage every 5.
2. **Each part of the solver earns its place**, comparing variants against the full solver at garbage every 5:
   - **Advanced moves (tucks and spins):** survival goes from 2/8 to 6/8, worth 2.9 T-spins per game.
   - **Bag knowledge:** survival goes from 4/8 without it to 6/8 with it; at garbage every 3, 80s without it against 97s.
3. **Speed matters when nothing else does.** At garbage every 8 every strong controller survives. Lookahead decides in about 5ms against the solver's 80–140ms, so it places more pieces, reaches higher levels and scores about 30% more. The OR edge appears only when the planning is needed.
4. **Decision models can't keep up with real time.** clef-flash takes about 1.8s per move, so its pieces fall while it thinks, and it digs holes when they land. It topped out at about 83s in every game with under 1,000 points: two orders of magnitude below the solver.
5. **The original heuristics (well-keeper, danger-adaptive) collapse under garbage.** Saving rows for Tetrises is the wrong bet when the floor keeps rising. Plain Dellacherie also falls well short of lookahead.
6. **A cost of acting slowly that's easy to miss.** At high levels, gravity (7–18ms per row) outruns 80ms moves. Even a decision made in time can run out of lock delay mid-move, shown as `missed` (2.5–4.8 per game for the solver at garbage every 5). The 80ms move speed is a setting.

## Reproduce

```bash
npm run solver                                  # OR solver on :8100 (or the "or-solver" launch config)
node --no-warnings scripts/race.ts seeds=1-8 minutes=3 garbage=8,5,3 tag=hard solver:300+adv solver:300 solver:300+adv+strict heuristic:lookahead heuristic:dellacherie heuristic:well-keeper heuristic:danger-adaptive
node --no-warnings scripts/race.ts seeds=1-3 minutes=3 garbage=8,5 tag=hard model:clef-flash model:clef
node --no-warnings scripts/race-summary.ts tag=hard
npm test && npm run test:solver
```

The results were produced after an adversarial review of the new code (4 reviewers, 2 skeptics per finding; 13 of 22 findings confirmed and fixed). Fixes that changed the solver:
- on a deadline it now never compares moves searched to different depths;
- it plans for garbage that lands right after the current piece;
- a top-out always scores worse than surviving, including a blocked spawn;
- small bag remainders are padded to a full set of scenarios.
