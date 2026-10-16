// Proxies a placement request to the Python OR-solver service (or-solver/, port 8100).
// No fallback: if the solver is down the board's piece simply locks under gravity, which keeps the race honest.
const SOLVER_URL = process.env.OR_SOLVER_URL ?? "http://127.0.0.1:8100";

export async function POST(req: Request) {
  const body = await req.json();
  const budget = body?.timing?.budgetMs;
  if (!Array.isArray(body?.board) || typeof body?.active?.piece !== "string" || !(budget > 0 && budget <= 10_000)) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const t = performance.now();
  try {
    const res = await fetch(`${SOLVER_URL}/solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(budget + 2000)]),
    });
    const data = await res.json();
    if (!res.ok) return Response.json({ error: JSON.stringify(data.detail ?? data) }, { status: 502 });
    return Response.json({ ...data, ms: performance.now() - t });
  } catch (e) {
    return Response.json({ error: `OR solver unreachable at ${SOLVER_URL}: ${(e as Error).message}` }, { status: 502 });
  }
}
