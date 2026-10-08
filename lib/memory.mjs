import * as fs from "node:fs/promises";
import path from "node:path";
import { atomic, command, living, processInfo, readJson, sameProcess, TERMINAL } from "./core.mjs";

// Observational only: includes the supervisor and its owned descendants, never
// the shared Herdr server or coordinator. Sampling failures cannot stop a worker.
export async function sampleMemory(identities) {
  const owned = await living(identities);
  const samples = await Promise.all(
    owned.map(async (p) => {
      try {
        let rssBytes,
          pssBytes = null;
        if (process.platform === "linux") {
          const status = await fs.readFile(`/proc/${p.pid}/status`, "utf8");
          rssBytes = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024;
          const rollup = await fs.readFile(`/proc/${p.pid}/smaps_rollup`, "utf8").catch(() => "");
          const pss = rollup.match(/^Pss:\s+(\d+)/m);
          if (pss) pssBytes = Number(pss[1]) * 1024;
        } else {
          const r = await command(["ps", "-o", "rss=", "-p", String(p.pid)]);
          if (r.code === 0 && r.stdout.trim()) rssBytes = Number(r.stdout.trim()) * 1024;
        }
        const after = await processInfo(p.pid);
        if (!Number.isFinite(rssBytes) || !after || !sameProcess(p, after)) return null;
        return { rssBytes, pssBytes };
      } catch {
        return null;
      }
    }),
  );
  const valid = samples.filter(Boolean);
  return {
    rssBytes: valid.length ? valid.reduce((n, s) => n + s.rssBytes, 0) : null,
    pssBytes:
      valid.length && valid.every((s) => s.pssBytes !== null)
        ? valid.reduce((n, s) => n + s.pssBytes, 0)
        : null,
    processes: valid.length,
    partial: valid.length !== owned.length,
  };
}

export async function memoryTracker(dir) {
  const file = path.join(dir, "memory.json");
  let state = await readJson(file).catch(() => null);
  let last = 0;
  return {
    async sample(identities) {
      if (Date.now() - last < 1000) return;
      last = Date.now();
      try {
        const current = await sampleMemory(identities);
        const peak = (key) =>
          current[key] === null
            ? (state?.[`peak${key[0].toUpperCase()}${key.slice(1)}`] ?? null)
            : Math.max(current[key], state?.[`peak${key[0].toUpperCase()}${key.slice(1)}`] ?? 0);
        state = {
          scope: "supervisor-and-descendants",
          sampledAt: Date.now(),
          ...current,
          peakRssBytes: peak("rssBytes"),
          peakPssBytes: peak("pssBytes"),
        };
        await atomic(file, state);
      } catch {
        /* Best effort telemetry, independent of process supervision. */
      }
    },
    async idle() {
      if (!state) return;
      state = {
        ...state,
        sampledAt: Date.now(),
        rssBytes: 0,
        pssBytes: state.pssBytes === null ? null : 0,
        processes: 0,
      };
      await atomic(file, state).catch(() => {});
    },
  };
}

export async function taskMemory(run, task, now = Date.now()) {
  const attempt = task.attempts.at(-1);
  if (!attempt) return null;
  const file = path.join(run.dir, "tasks", task.spec.id, String(attempt.number), "memory.json");
  const memory = await readJson(file).catch(() => task.metrics?.memory ?? null);
  if (!memory) return null;
  const finished = TERMINAL.includes(task.status) && task.status !== "uncertain";
  const stale = !finished && now - memory.sampledAt > 5000;
  return {
    ...memory,
    stale,
    rssBytes: finished ? 0 : stale ? null : memory.rssBytes,
    pssBytes: finished && memory.pssBytes !== null ? 0 : stale ? null : memory.pssBytes,
  };
}

export function aggregateMemory(memories) {
  const known = memories.filter(Boolean);
  if (!known.length) return null;
  const sum = (key) =>
    known.every((m) => m[key] !== null && m[key] !== undefined)
      ? known.reduce((n, m) => n + m[key], 0)
      : null;
  return {
    scope: "supervisors-and-descendants",
    rssBytes: sum("rssBytes"),
    pssBytes: sum("pssBytes"),
    // Peaks need not happen together; these sums are NOT a simultaneous run peak.
    peakRssUpperBoundBytes: sum("peakRssBytes"),
    peakPssUpperBoundBytes: sum("peakPssBytes"),
    partial: known.length !== memories.length || known.some((m) => m.partial || m.stale),
  };
}

export function memoryText(memory) {
  if (!memory) return "";
  const key = memory.pssBytes !== null && memory.pssBytes !== undefined ? "pssBytes" : "rssBytes";
  if (memory[key] === null || memory[key] === undefined) return "memory unknown";
  const peak = key === "pssBytes" ? "peakPssBytes" : "peakRssBytes";
  const peakSum = key === "pssBytes" ? "peakPssUpperBoundBytes" : "peakRssUpperBoundBytes";
  const unit = key === "pssBytes" ? "PSS" : "RSS";
  if (memory[key] === 0 && memory[peak])
    return `sampled peak ${Math.round(memory[peak] / 1048576)} MiB ${unit}`;
  if (memory[key] === 0 && memory[peakSum])
    return `sampled peaks sum ${Math.round(memory[peakSum] / 1048576)} MiB ${unit}`;
  return `${Math.round(memory[key] / 1048576)} MiB ${key === "pssBytes" ? "PSS" : "RSS"}${memory.partial ? " (partial)" : ""}`;
}
