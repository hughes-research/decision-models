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
