// Headless application uses the same snapshots, conflict checks and journal as Pi.
import { join } from "node:path";
import { integrate } from "../verify/integrate.ts";
import { resolveView } from "../viewer/selection.ts";
import { readRunRecord } from "../verify/record.ts";

export async function withInterrupt<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Cancelled"));
  process.prependListener("SIGINT", abort);
  process.prependListener("SIGTERM", abort);
  try {
    return await work(controller.signal);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

export type DeliveryOptions = {
  json?: boolean;
  write: (line: string) => void;
  signal?: AbortSignal;
  recover?: boolean;
};

export async function deliver(
  dir: string,
  run: string,
  { json, write, signal, recover }: DeliveryOptions,
): Promise<number> {
  write(
    json
      ? JSON.stringify({ t: "integration_started", run })
      : `Pinata ${run.slice(0, 8)} · Applying isolated snapshots`,
  );
  try {
    const result = await integrate(dir, signal, undefined, { recover });
    write(
      json
        ? JSON.stringify({ t: "integration_finished", run, ...result })
        : `Pinata ${run.slice(0, 8)} · ${result.status} · ${result.files.length} files · receipt ${result.journal}`,
    );
    if (signal?.aborted) return 3;
    return result.status === "applied" ? 0 : 1;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const journal = join(dir, "integration", "journal.json");
    write(
      json
        ? JSON.stringify({ t: "integration_failed", run, reason, journal })
        : `Pinata ${run.slice(0, 8)} · Integration failed: ${reason}. If application started, inspect ${journal}`,
    );
    return signal?.aborted ? 3 : 1;
  }
}

export async function integrateCommand(
  run: string,
  options: Omit<DeliveryOptions, "signal">,
): Promise<number> {
  return withInterrupt(async (signal) => {
    const { runs } = await resolveView({ run }, process.cwd());
    const record = await readRunRecord(runs[0]);
    return deliver(runs[0], record.id, { ...options, signal });
  });
}
