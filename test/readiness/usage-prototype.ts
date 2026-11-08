// New accounting contract spike: finalized totals need explicit per-attempt coverage.
import { z } from "zod";

const usage = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cost: z.number().nonnegative(),
});
const observation = z.strictObject({
  key: z.string().min(1),
  responseComplete: z.boolean(),
  usage,
});
type Usage = z.infer<typeof usage>;

export function reconcileUsage(started: string[], observations: unknown[], damaged = false) {
  const totals = new Map<string, Usage>();
  const unknown = new Set<string>();
  for (const raw of observations) {
    const parsed = observation.safeParse(raw);
    if (!parsed.success) {
      damaged = true;
      continue;
    }
    const item = parsed.data;
    if (!started.includes(item.key)) {
      damaged = true;
      continue;
    }
    if (!item.responseComplete) {
      unknown.add(item.key);
      continue;
    }
    const previous = totals.get(item.key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item.usage)) unknown.add(item.key);
    totals.set(item.key, item.usage);
  }
  for (const key of started) if (!totals.has(key)) unknown.add(key);
  if (damaged || unknown.size || !started.length)
    return {
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      covered: totals.size,
      missing: [...unknown],
      damaged,
    };
  const values = [...totals.values()];
  return {
    inputTokens: values.reduce(
      (sum, entry) => sum + entry.input + entry.cacheRead + entry.cacheWrite,
      0,
    ),
    outputTokens: values.reduce((sum, entry) => sum + entry.output, 0),
    costUsd: values.reduce((sum, entry) => sum + entry.cost, 0),
    covered: values.length,
    missing: [],
    damaged,
  };
}
