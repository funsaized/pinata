// Epoch timestamps survive process changes; duration limits remain upper bounds.
export function validateDeadline(value: unknown): number | undefined {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("deadlineAt must be a positive safe integer epoch timestamp");
  return value;
}

export function remaining(
  deadlineAt: number | undefined,
  maximum: number,
  now = Date.now(),
): number {
  return Math.max(0, Math.min(maximum, deadlineAt === undefined ? maximum : deadlineAt - now));
}

export function assertTime(deadlineAt: number | undefined, now = Date.now()): void {
  if (deadlineAt !== undefined && deadlineAt <= now) throw new Error("Run deadline exceeded");
}

export function capDeadline(...values: Array<number | undefined>): number | undefined {
  const deadlines = values.filter(
    (value): value is number => validateDeadline(value) !== undefined,
  );
  return deadlines.length ? Math.min(...deadlines) : undefined;
}

// Own the timer strongly until all work (including interrupted subprocess cleanup) finishes.
export async function withDeadline<T>(
  deadlineAt: number | undefined,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  assertTime(deadlineAt);
  if (deadlineAt === undefined) return work(signal);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Run deadline exceeded")),
    remaining(deadlineAt, 2_147_483_647),
  );
  timer.unref();
  try {
    return await work(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
