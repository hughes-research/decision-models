# Changelog

This file lists every notable change to decision-models, newest first. It is for anyone who wants to know what changed between milestones, and why.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). The project has no tagged releases, so each entry is a milestone on `main`, named and dated, with the commits it covers. To see a change in full, run `git show <commit>` from the repository root.

## Unreleased

### Added

- A full documentation set. [docs/README.md](docs/README.md) is the documentation home, with pages on [getting started](docs/getting-started.md), [presenting the demo](docs/lecture-guide.md), [concepts](docs/concepts.md), [architecture](docs/architecture.md), the [game engine](docs/game-engine.md), [controllers](docs/controllers.md), the [OR solver](docs/or-solver.md), [experiments](docs/experiments.md), the [API reference](docs/api-reference.md) and [troubleshooting](docs/troubleshooting.md).
- [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md) and this changelog.
- The MIT license in [LICENSE](LICENSE).
- A screenshot of the race at `docs/images/race.png`.

### Changed

- [README.md](README.md) is the project front page. It replaces the Create Next App boilerplate.
- `.gitignore` ignores browser automation output in `.playwright-mcp/`.

## Safe network defaults - 2026-10-19

Commit `42dad37`.

### Added

- `npm run demo` builds the app and serves the production build on `0.0.0.0:3000`, with no developer endpoints and no source maps. Use it whenever you show the demo on a network.
- `npm run dev:lan` runs the dev server on `0.0.0.0:3000`. Use it on trusted networks only.

### Security

- `npm run dev` listens on `127.0.0.1:3000` again. On a network, the Next.js dev server exposes developer endpoints, such as opening files in your editor, and source maps that contain home-directory paths.
- `allowedDevOrigins` in `next.config.ts` is built at startup from this machine's own IPv4 addresses and `.local` name. It replaces the `"*.*.*.*"` wildcard, which matched any four-label domain.
- A machine-specific network address is removed from a comment in `next.config.ts`.
- `.claude/settings.local.json`, which holds local agent permissions, is ignored by the repository's own `.gitignore`, not only by a global one.
- An audit for personal data and secrets, a regex scan of the full history plus an independent review, found no passwords, keys or tokens.

## Time-based garbage, LED clock and music - 2026-10-16

Commits `dc340b7` and `90a8827`.

### Added

- A seven-segment LED countdown clock (`app/Clock.tsx`).
- A chiptune of the public-domain folk tune Korobeiniki, synthesized with the Web Audio API (`app/music.ts`). It starts when you press Start and speeds up with the level and the race's progress.
- `passTime()` and `msUntilGarbage()` in `lib/engine.ts`, which drive the shared garbage clock.
- Part 3 of the results in [experiments/RESULTS.md](experiments/RESULTS.md#part-3-the-same-race-with-fair-time-based-garbage): the race rerun with fair, time-based garbage. The OR solver roughly ties the lookahead heuristic; advanced moves and bag knowledge still help it; the decision models top out in 35–75 seconds; the weaker heuristics collapse. The lesson: how fairly the garbage clock is set decides who looks smartest.

### Changed

- Rising garbage is time-based: one row every N seconds, on one clock shared by all boards. Rows that queue up while a controller thinks are pushed in at that board's next lock, as in versus Tetris. The engine setting `garbageEvery` (pieces) is now `garbageMs` (milliseconds).
- The solver's `/solve` request follows the new rule: `rules.garbageEvery` is replaced by `rules.garbageMs`, and `state.piecesUntilGarbage` by `state.pendingGarbage`, `state.msUntilGarbage` and `state.avgPieceMs`. The solver plans for the garbage rows due after each piece.
- The podium ranks by survival first, then score.
- Blocks are drawn as beveled SVG tiles, and the boards line up.
- `npm run dev` and `npm run start` listen on `0.0.0.0:3000`, and the dev server allows LAN origins. For `dev`, this was reverted by [safe network defaults](#safe-network-defaults---2026-10-19).
- The time-based race data is in `experiments/race.jsonl`. The earlier per-piece runs moved to `experiments/race-pieces.jsonl`.

### Fixed

- A slow controller could dodge garbage, because garbage arrived per piece placed and a slow controller placed fewer pieces. Time-based garbage closes that gap. Part 2 of the results is marked as superseded.

## Hard-mode race: decision model vs heuristic vs OR solver - 2026-10-16

Commit `a0b590c`.

### Added

- Three boards race, each with its own controller: a decision model (`clef` or `clef-flash`), any of the 22 heuristics, or the OR solver (`app/Board.tsx`, `lib/controllers.ts`).
- SRS rotation with wall kicks, tucks and T-spins (`lib/srs.ts`), behind a per-board "advanced moves" switch.
- A real-time engine (`lib/engine.ts`): guideline gravity, a 500 ms lock delay, guideline and T-spin scoring, seeded rising garbage, and a speed level every 10 lines.
- A race simulator shared by the browser and the scripts (`lib/race.ts`). Gravity keeps running while a controller thinks, and each decision plays out visibly as the piece falls, slides and spins along its real path.
- The OR solver, a Python FastAPI service in `or-solver/` that you start with `npm run solver` on `127.0.0.1:8100`, and the `/api/solve` route that proxies to it. It plans 5–6 pieces ahead over the remaining 7-bag orders, under hard constraints and a time limit.
- A single source of rules: `scripts/fixtures.ts` (`npm run fixtures`) exports the TypeScript engine's tables and fixtures to Python, and parity tests check that both engines agree (`npm run test:solver`).
- A headless race harness and summary that measure the race in simulated time (`scripts/race.ts`, `scripts/race-summary.ts`).
- Tests for the engine, SRS and the race simulator (`lib/engine.test.ts`, `lib/srs.test.ts`, `lib/race.test.ts`).
- Part 2 of the results in [experiments/RESULTS.md](experiments/RESULTS.md#part-2-three-kinds-of-controller-at-hard-mode-tetris-garbage-per-piece-superseded-by-part-3), with garbage per piece placed. The numbers were produced after an adversarial review of the new code, whose 13 confirmed findings were fixed. Part 3 supersedes these results.

### Changed

- `/api/decide` passes the client's abort signal to Ollama, so a piece that locks first cancels its request. It returns status 499 when the client gives up, and a 502 with a clearer message when Ollama fails or is unreachable.

## Heuristic assist with 22 methods - 2026-10-16

Commit `dcb03b5`.

### Added

- A heuristic assist on each board. When the model's confidence is below a per-model gate, one of 22 methods picks the move instead: 5 classic Tetris heuristics, 4 original ones, 3 learned from the models' own judgments, and 10 model and heuristic fusion rules (`lib/heuristics.ts`).
- Learned weights fitted from the models' judgments (`lib/learned.ts`, written by `scripts/fit.ts`).
- `lib/prompt.ts`, which builds the `systemone` move request shared by the API route and the experiment scripts.
- The experiment scripts `scripts/collect.ts`, `scripts/fit.ts`, `scripts/bench.ts`, `scripts/offline.ts` and `scripts/live.ts`, with the collected model data in `experiments/data/`.
- The `npm test` and `npm run bench` scripts, and tests for the heuristics (`lib/heuristics.test.ts`).
- Part 1 of the results in [experiments/RESULTS.md](experiments/RESULTS.md#heuristic-assist-for-clef-and-clef-flash-experiment-results). Both models are nearly always undecided and dig holes they could avoid. The best assists cut clef-flash's offline regret by about two-thirds, and `clef-hole-sense`, learned from clef's own board ratings, was the best live assist.

## Clef vs clef-flash race - 2026-10-16

Commit `984c439`.

### Added

- Two Tetris boards side by side, each played by a local Ollama decision model, `clef` or `clef-flash`.
- Each move offers up to 26 hard-drop placements as one `choice` question to Ollama's `/v1/systemone` endpoint, through the `/api/decide` route.
- Both boards get the same pieces in the same order, from a seed you set.
- A match timer, and a spin and drop animation while the model thinks and plays.
- The board and placement logic in `lib/tetris.ts`, with tests (`lib/tetris.test.ts`).

## Project scaffold - 2026-10-16

Commit `75eec31`.

### Added

- A Next.js 16.4.2 app from Create Next App, with React 19.3, TypeScript, Tailwind CSS 4 and ESLint.

## Next steps

- [Project README](README.md): what the project is and how to run it.
- [Experiment results](experiments/RESULTS.md): the findings behind each milestone.
- [Contributing](CONTRIBUTING.md): how to propose a change and record it here.
