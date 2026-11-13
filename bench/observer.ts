import {
  assignmentKey,
  type ArtifactPort,
  type Assignment,
  type BackendPort,
  type RuntimeEvent,
  type WorkspacePort,
} from "../engine/contracts/index.ts";
import { now, stat } from "./metrics.ts";
import type { SyncMeasurement } from "./types.ts";

type QueueEvent =
  | { at: number; kind: "accepted"; assignments: Assignment[] }
  | { at: number; kind: "start" | "settled"; key: string };
export class Observer {
  readonly launched: Record<string, number> = {};
  readonly setup: Record<string, number> = {};
  readonly settled: Record<string, number> = {};
  readonly called: Record<string, number> = {};
  readonly accepted: Record<string, number> = {};
  readonly cleanup: Record<string, number> = {};
  readonly restore: Record<string, number> = {};
  readonly stages: Record<string, Record<string, number>> = {
    prepareInvokedAt: {},
    prepareReturnedAt: {},
    preparedAt: {},
    launchIntentAt: {},
    enrolledAt: {},
    runningAt: {},
    outcomeAt: {},
    captureInvokedAt: {},
    captureReturnedAt: {},
    backendRssBeforeMB: {},
    backendRssAfterMB: {},
    captureRssBeforeMB: {},
    captureRssAfterMB: {},
  };
  readonly notices: Record<string, number> = {};
  readonly after = new Map<string, string[]>();
  readonly journalSync: number[] = [];
  readonly artifactSync: number[] = [];
  readonly acceptance: number[] = [];
  readonly leases = new Set<string>();
  readonly errors: string[] = [];
  readonly queueEvents: QueueEvent[] = [];
  activityEvents = 0;
  committedEvents = 0;
  artifactBytesRead = 0;
  artifactBytesSubmitted = 0;
  running = 0;
  maxRunning = 0;
  private readonly attempts = new Map<string, string>();
  private readonly syncs = new Map<string, { start: number; active: number; ambiguous: boolean }>();
  private readonly syncTotals = new Map<
    string,
    {
      attempts: number;
      completed: number;
      totalMs: number;
      busyMs: number;
      maxConcurrent: number;
      previous: number;
      active: number;
      distinct: number[];
    }
  >();
  event = (event: RuntimeEvent): void => {
    const at = now();
    if (event.kind === "activity") {
      this.activityEvents++;
      return;
    }
    if (event.kind !== "committed") return;
    this.committedEvents++;
    const transition = event.transition;
    if (transition.kind === "attempt_started")
      this.attempts.set(transition.attempt.id, assignmentKey(transition.attempt.ref));
    if (transition.kind === "effect_intent" && transition.effect.kind === "launch")
      this.stages.launchIntentAt[assignmentKey(transition.effect.ref)] = at;
    if (transition.kind === "assignment_state" && transition.execution.phase === "running")
      this.stages.runningAt[assignmentKey(transition.ref)] = at;
    if (
      transition.kind === "workspace_prepared" ||
      transition.kind === "backend_enrolled" ||
      transition.kind === "attempt_outcome"
    ) {
      const key = this.attempts.get(transition.attemptId);
      const stage =
        transition.kind === "workspace_prepared"
          ? "preparedAt"
          : transition.kind === "backend_enrolled"
            ? "enrolledAt"
            : "outcomeAt";
      if (key) this.stages[stage][key] = at;
    }
    if (transition.kind === "accepted") {
      this.queueEvents.push({ at, kind: "accepted", assignments: transition.assignments });
      for (const assignment of transition.assignments) {
        const key = assignmentKey(assignment.ref);
        this.accepted[key] = at;
        this.after.set(key, assignment.after.map(assignmentKey));
      }
    }
    if (transition.kind === "assignment_state" && transition.execution.phase === "preparing") {
      const key = assignmentKey(transition.ref);
      this.launched[key] = at;
      this.queueEvents.push({ at, kind: "start", key });
      this.running++;
      this.maxRunning = Math.max(this.maxRunning, this.running);
    }
    if (transition.kind === "settled") {
      const key = assignmentKey(transition.result.ref);
      this.settled[key] = at;
      this.queueEvents.push({ at, kind: "settled", key });
      this.running = Math.max(0, this.running - 1);
    }
  };
  fault = (point: string): void => {
    if (!/\.(?:sync|directory-sync)\.(?:before|after)$/.test(point)) return;
    const phase = point.slice(0, point.lastIndexOf("."));
    const at = now();
    const total = this.syncTotals.get(phase) ?? {
      attempts: 0,
      completed: 0,
      totalMs: 0,
      busyMs: 0,
      maxConcurrent: 0,
      previous: at,
      active: 0,
      distinct: [],
    };
    const elapsed = Math.max(0, at - total.previous);
    total.totalMs += elapsed * total.active;
    if (total.active) total.busyMs += elapsed;
    total.previous = at;
    this.syncTotals.set(phase, total);
    if (point.endsWith(".before")) {
      total.attempts++;
      total.active++;
      total.maxConcurrent = Math.max(total.maxConcurrent, total.active);
      const current = this.syncs.get(phase);
      if (current) {
        current.active++;
        current.ambiguous = true;
      } else this.syncs.set(phase, { start: at, active: 1, ambiguous: false });
      return;
    }
    total.completed++;
    total.active--;
    const current = this.syncs.get(phase);
    if (!current) return;
    current.active--;
    if (current.active) return;
    this.syncs.delete(phase);
    if (!current.ambiguous) {
      const duration = at - current.start;
      total.distinct.push(duration);
      if (!phase.endsWith("directory-sync"))
        (point.startsWith("journal.") ? this.journalSync : this.artifactSync).push(duration);
    }
  };
  fsync(): Record<string, SyncMeasurement> {
    return Object.fromEntries(
      [...this.syncTotals].map(([phase, value]) => [
        phase,
        {
          attempts: value.attempts,
          completed: value.completed,
          totalMs: value.totalMs,
          busyMs: value.busyMs,
          maxConcurrent: value.maxConcurrent,
          distinct: stat(value.distinct),
        },
      ]),
    );
  }
  artifacts(port: ArtifactPort): ArtifactPort {
    return {
      put: async (bytes) => {
        this.artifactBytesSubmitted += bytes.length;
        return port.put(bytes);
      },
      read: async (ref) => {
        const bytes = await port.read(ref);
        this.artifactBytesRead += bytes.length;
        return bytes;
      },
    };
  }
  backend(backend: BackendPort): BackendPort {
    return {
      kind: backend.kind,
      capabilities: backend.capabilities,
      start: async (launch, observe, signal) => {
        const key = assignmentKey(launch.ref);
        const start = now();
        this.setup[key] = start;
        this.stages.backendRssBeforeMB[key] = process.memoryUsage().rss / 1_048_576;
        const handle = await backend.start(
          { ...launch, artifacts: this.artifacts(launch.artifacts) },
          observe,
          signal,
        );
        this.stages.backendRssAfterMB[key] = process.memoryUsage().rss / 1_048_576;
        if (launch.continuation) this.restore[key] = now() - start;
        return {
          identity: handle.identity,
          done: handle.done,
          input: (message) => handle.input(message),
          checkpoint: () => handle.checkpoint(),
          stop: async (reason) => {
            const before = now();
            const stopped = await handle.stop(reason);
            this.cleanup[key] = now() - before;
            return stopped;
          },
        };
      },
    };
  }
  workspace(port: WorkspacePort): WorkspacePort {
    return {
      prepare: async (request, signal) => {
        const key = assignmentKey(request.ref);
        this.stages.prepareInvokedAt[key] = now();
        const prepared = await port.prepare(
          { ...request, artifacts: this.artifacts(request.artifacts) },
          signal,
        );
        this.stages.prepareReturnedAt[key] = now();
        if (prepared.lease) this.leases.add(prepared.lease.id);
        return prepared;
      },
      capture: async (request, signal) => {
        if (!port.capture) throw new Error("Workspace adapter has no legacy capture support");
        const key = assignmentKey(request.ref);
        this.stages.captureInvokedAt[key] = now();
        this.stages.captureRssBeforeMB[key] = process.memoryUsage().rss / 1_048_576;
        const captured = await port.capture(
          { ...request, artifacts: this.artifacts(request.artifacts) },
          signal,
        );
        this.stages.captureReturnedAt[key] = now();
        this.stages.captureRssAfterMB[key] = process.memoryUsage().rss / 1_048_576;
        return captured;
      },
      release: async (request) => {
        await port.release({ ...request, artifacts: this.artifacts(request.artifacts) });
        if (request.prepared.lease) this.leases.delete(request.prepared.lease.id);
      },
    };
  }
  queue(capacity: number | null) {
    const queued = new Map<
      string,
      {
        worker: string;
        after: string[];
        totals: Record<"fifo" | "dependency" | "capacity" | "ready", number>;
      }
    >();
    const ended = new Set<string>();
    const workers = new Map<string, string>();
    const active = new Set<string>();
    const totals = {
      fifo: [] as number[],
      dependency: [] as number[],
      capacity: [] as number[],
      ready: [] as number[],
    };
    let previous = this.queueEvents[0]?.at ?? 0;
    for (const event of this.queueEvents) {
      const elapsed = Math.max(0, event.at - previous);
      for (const entry of queued.values()) {
        const outstanding = entry.after.filter((key) => !ended.has(key));
        const reason = outstanding.some((key) => workers.get(key) === entry.worker)
          ? "fifo"
          : outstanding.length
            ? "dependency"
            : capacity !== null && active.size >= capacity
              ? "capacity"
              : "ready";
        entry.totals[reason] += elapsed;
      }
      previous = event.at;
      if (event.kind === "accepted") {
        for (const assignment of event.assignments) {
          const key = assignmentKey(assignment.ref);
          workers.set(key, assignment.ref.worker);
          queued.set(key, {
            worker: assignment.ref.worker,
            after: assignment.after.map(assignmentKey),
            totals: { fifo: 0, dependency: 0, capacity: 0, ready: 0 },
          });
        }
      } else if (event.kind === "start") {
        const entry = queued.get(event.key);
        if (entry)
          for (const reason of ["fifo", "dependency", "capacity", "ready"] as const)
            totals[reason].push(entry.totals[reason]);
        queued.delete(event.key);
        active.add(event.key);
      } else {
        ended.add(event.key);
        active.delete(event.key);
      }
    }
    return {
      fifo: stat(totals.fifo),
      dependency: stat(totals.dependency),
      capacity: stat(totals.capacity),
      ready: stat(totals.ready),
    };
  }
}
