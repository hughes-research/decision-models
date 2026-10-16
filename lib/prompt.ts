// The systemone request for one move, shared by the API route and the experiment scripts.
export type Opt = { letter: string; text: string };

export const moveRequest = (model: string, board: string, piece: string, options: Opt[]) => ({
  model,
  keep_alive: "30m",
  state: {
    board,
    legend: "10 wide x 20 tall, top row first. '#' = filled, '.' = empty.",
    piece,
    goal: "Survive as long as possible and clear lines. Holes and tall stacks are bad.",
    request_id: crypto.randomUUID(), // replaying a seed would otherwise hit Ollama's cache and fake the timings
  },
  questions: {
    move: {
      type: "choice",
      instructions: `Where should the ${piece} piece be dropped for the best long-term Tetris play?`,
      criteria: Object.fromEntries(options.map((o) => [o.letter, o.text])),
    },
  },
});
