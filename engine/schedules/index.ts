import { performance } from "node:perf_hooks";
import {
  assignmentKey,
  DomainError,
  type CallerAuthority,
  type CommandEnvelope,
  type CoreState,
  type FrozenWorker,
  type WorkerRequest,
} from "../contracts/index.ts";
import type { AcceptedTransition, Transition } from "../contracts/lifecycle.ts";
import type { ScheduleState } from "../contracts/schedule.ts";
import { digestValue } from "../contracts/digest.ts";
import { prepareCommand, checkResolvedWorker } from "../core/accept.ts";
import { normalizeTrigger, nextOccurrence, localMinute } from "./timing.ts";

export type ScheduleClock = {
  wall(): number;
  monotonic(): number;
  timer(wake: () => void, milliseconds: number): { cancel(): void };
};
const systemClock: ScheduleClock = {
  wall: () => Date.now(),
  monotonic: () => performance.now(),
  timer: (wake, milliseconds) => {
    const handle = setTimeout(wake, milliseconds);
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};
export type SchedulingOptions = {
  sessionId: string;
  caller: CallerAuthority;
  clock?: ScheduleClock;
  maxLatenessMs?: number;
};
type ScheduleChange = Extract<Transition, { kind: "schedule_changed" }>;
type ScheduleHost = {
  transaction<T>(
    work: (state: CoreState, commit: (transition: Transition) => Promise<void>) => Promise<T>,
  ): Promise<T>;
  freeze(request: WorkerRequest, caller: CallerAuthority): Promise<FrozenWorker>;
  validate(command: CommandEnvelope["command"], state: CoreState): Promise<void>;
  diagnostic(message: string): void;
};

export class Schedules {
  private readonly options: SchedulingOptions;
  private readonly clock: ScheduleClock;
  private readonly host: ScheduleHost;
  private timer?: { cancel(): void };
  private stopped = false;
  private ticking?: Promise<void>;
  private readonly deadlines = new Map<string, { nextAt: string; monotonic: number }>();
  constructor(host: ScheduleHost, options: SchedulingOptions) {
    this.host = host;
    this.options = { ...options, caller: structuredClone(options.caller) };
    this.clock = options.clock ?? systemClock;
    if (!options.sessionId || options.caller.kind !== "coordinator")
      throw new DomainError(
        "invalid_input",
        "Scheduling requires an explicit session and coordinator authority",
      );
  }

  async open(): Promise<void> {
    await this.host.transaction(async (state, commit) => {
      for (const schedule of Object.values(state.schedules)) {
        if (schedule.status !== "active") continue;
        const sameSession = schedule.sessionId === this.options.sessionId;
        const requestId = `schedule:${schedule.id}:recover:${state.revision}:${schedule.revision}`;
        await commit(
          this.change(state, requestId, sameSession ? "recover" : "close", {
            ...schedule,
            revision: schedule.revision + 1,
            status: sameSession ? "paused" : "closed",
            nextAt: sameSession ? schedule.nextAt : null,
          }),
        );
        // transaction snapshots are immutable; each control uses the revision after
        // the previous one to keep receipt identities contiguous.
        state = { ...state, revision: state.revision + 1 };
      }
    });
  }

  private change(
    state: CoreState,
    requestId: string,
    action: ScheduleChange["action"],
    schedule?: ScheduleState,
    payloadDigest = digestValue({ action, schedule: schedule ?? null }),
  ): ScheduleChange {
    return {
      kind: "schedule_changed",
      requestId,
      payloadDigest,
      action,
      ...(schedule ? { schedule } : {}),
      receipt: {
        status: "accepted",
        requestId,
        revision: state.revision + 1,
        assignments: [],
        resolved: [],
        schedules: schedule ? [schedule] : Object.values(state.schedules),
      },
    };
  }

  private localKeys(schedule: ScheduleState): string[] {
    if (schedule.trigger.kind !== "cron") return [];
    const timezone = schedule.trigger.timezone;
    const cutoff =
      Date.parse(schedule.nextAt ?? new Date(this.clock.wall()).toISOString()) - 172_800_000;
    return Object.keys(schedule.occurrences)
      .filter((at) => Date.parse(at) >= cutoff)
      .map((at) => localMinute(at, timezone));
  }

  async prepare(
    state: CoreState,
    envelope: CommandEnvelope,
    caller: CallerAuthority,
  ): Promise<ScheduleChange> {
    if (
      caller.kind !== "coordinator" ||
      caller.id !== this.options.caller.id ||
      caller.run !== this.options.caller.run
    )
      throw new DomainError(
        "capability_denied",
        "Schedules belong to the configured coordinator session",
      );
    if (envelope.expectedRevision !== undefined && envelope.expectedRevision !== state.revision)
      throw new DomainError("conflict", "Schedule request has a stale revision");
    if (envelope.command.kind !== "schedule")
      throw new DomainError("invalid_input", "Expected schedule command");
    const command = envelope.command.schedule;
    if (command.action === "list")
      return this.change(state, envelope.requestId, "list", undefined, digestValue(envelope));
    const previous = Object.hasOwn(state.schedules, command.id)
      ? state.schedules[command.id]
      : undefined;
    if (
      command.action === "create"
        ? previous
        : !previous ||
          previous.sessionId !== this.options.sessionId ||
          previous.status === "closed" ||
          previous.status === "deleted"
    )
      throw new DomainError("conflict", "Schedule identity is unavailable in this session");
    const now = new Date(this.clock.wall()).toISOString();
    let schedule: ScheduleState;
    if (command.action === "create" || command.action === "update") {
      const target = command.target;
      let frozen = previous
        ? { target: previous.target, task: previous.task, template: previous.template }
        : undefined;
      if (target && "template" in target) {
        if (
          Object.hasOwn(state.workers, target.template.id) ||
          Object.values(state.schedules).some(
            (entry) =>
              entry.id !== command.id &&
              entry.target.worker === target.template.id &&
              entry.template,
          )
        )
          throw new DomainError(
            "conflict",
            "A changed schedule template requires an unused replacement worker ID",
          );
        const worker = await this.host.freeze(target.template, caller);
        checkResolvedWorker(target.template, worker, this.options.caller);
        frozen = {
          target: { worker: worker.id },
          task: target.template.task,
          template: { request: target.template, worker },
        };
      } else if (target) {
        const worker = state.workers[target.worker];
        const latest = state.latest[target.worker];
        const assignment =
          state.assignments[
            assignmentKey({ run: state.run, worker: target.worker, assignment: latest })
          ];
        if (!worker || !assignment || worker.parentAssignment)
          throw new DomainError("invalid_input", "Schedule target must be an existing root worker");
        checkResolvedWorker(
          {
            id: worker.id,
            agent: worker.agent,
            task: assignment.task,
            after: [],
            inputs: [],
            context: [],
          },
          worker,
          this.options.caller,
        );
        frozen = { target, task: assignment.task, template: undefined };
      }
      if (!frozen) throw new DomainError("invalid_input", "Schedule creation needs a target");
      const triggerInput = command.trigger ?? previous?.trigger;
      if (!triggerInput) throw new DomainError("invalid_input", "Schedule trigger is unavailable");
      const trigger = normalizeTrigger(triggerInput);
      schedule = {
        id: command.id,
        sessionId: this.options.sessionId,
        revision: (previous?.revision ?? 0) + 1,
        trigger,
        overlap: command.overlap ?? previous?.overlap ?? "skip",
        status: "paused",
        target: frozen.target,
        task: frozen.task,
        ...(frozen.template ? { template: frozen.template } : {}),
        nextAt: trigger.kind === "at" ? trigger.at : nextOccurrence(trigger, now),
        occurrences: previous?.occurrences ?? {},
      };
    } else {
      if (!previous) throw new DomainError("conflict", "Schedule does not exist");
      schedule = {
        ...previous,
        revision: previous.revision + 1,
        status:
          command.action === "resume"
            ? "active"
            : command.action === "pause"
              ? "paused"
              : "deleted",
      };
      if (command.action === "resume") {
        schedule.activatedAt = now;
        // Resumption starts from the current session time, never from a backlog.
        schedule.nextAt =
          schedule.trigger.kind === "at"
            ? schedule.trigger.at
            : nextOccurrence(schedule.trigger, now, this.localKeys(schedule));
        if (schedule.nextAt && Object.hasOwn(schedule.occurrences, schedule.nextAt))
          throw new DomainError("conflict", "One-shot occurrence is already recorded");
      }
      if (command.action === "delete") schedule.nextAt = null;
    }
    return this.change(state, envelope.requestId, command.action, schedule, digestValue(envelope));
  }

  changed(state: CoreState): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (this.stopped) return;
    let nextDelay = Infinity;
    const activeIds = new Set<string>();
    for (const schedule of Object.values(state.schedules)) {
      if (
        schedule.sessionId !== this.options.sessionId ||
        schedule.status !== "active" ||
        !schedule.nextAt
      )
        continue;
      activeIds.add(schedule.id);
      let delay = Date.parse(schedule.nextAt) - this.clock.wall();
      if (schedule.trigger.kind === "interval") {
        let deadline = this.deadlines.get(schedule.id);
        if (!deadline || deadline.nextAt !== schedule.nextAt) {
          deadline = {
            nextAt: schedule.nextAt,
            monotonic: this.clock.monotonic() + schedule.trigger.milliseconds,
          };
          this.deadlines.set(schedule.id, deadline);
        }
        delay = deadline.monotonic - this.clock.monotonic();
      }
      nextDelay = Math.min(nextDelay, delay);
    }
    for (const id of this.deadlines.keys()) if (!activeIds.has(id)) this.deadlines.delete(id);
    if (Number.isFinite(nextDelay))
      this.timer = this.clock.timer(
        () => {
          void this.tick().catch((error: unknown) =>
            this.host.diagnostic(
              `Schedule wake failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        },
        Math.max(0, Math.min(nextDelay, 2_147_483_647)),
      );
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    const visited = new Set<string>();
    for (;;) {
      const processed = await this.host.transaction(async (state, commit) => {
        for (const schedule of Object.values(state.schedules)) {
          if (
            visited.has(schedule.id) ||
            this.stopped ||
            schedule.sessionId !== this.options.sessionId ||
            schedule.status !== "active" ||
            !schedule.nextAt
          )
            continue;
          const deadline = this.deadlines.get(schedule.id);
          const lateness =
            schedule.trigger.kind === "interval" && deadline
              ? this.clock.monotonic() - deadline.monotonic
              : this.clock.wall() - Date.parse(schedule.nextAt);
          if (lateness < 0) continue;
          visited.add(schedule.id);
          const requestId = `schedule:${schedule.id}:${schedule.nextAt}`;
          const payloadDigest = digestValue({
            scheduleId: schedule.id,
            scheduledAt: schedule.nextAt,
          });
          const now = new Date(this.clock.wall()).toISOString();
          const localKey =
            schedule.trigger.kind === "cron"
              ? localMinute(schedule.nextAt, schedule.trigger.timezone)
              : undefined;
          const missed =
            (schedule.trigger.kind === "at" &&
              !!schedule.activatedAt &&
              schedule.nextAt < schedule.activatedAt) ||
            lateness > (this.options.maxLatenessMs ?? 60_000) ||
            (schedule.trigger.kind === "interval" && lateness >= schedule.trigger.milliseconds);
          const nextAt =
            schedule.trigger.kind === "at"
              ? null
              : nextOccurrence(
                  schedule.trigger,
                  missed && now > schedule.nextAt ? now : schedule.nextAt,
                  [...this.localKeys(schedule), ...(localKey ? [localKey] : [])],
                );
          const overlapping = Object.values(state.assignments).some(
            (assignment) =>
              assignment.ref.worker === schedule.target.worker &&
              (assignment.execution.phase !== "ended" ||
                assignment.execution.cleanup !== "confirmed"),
          );
          let acceptance: AcceptedTransition | undefined;
          let reason = missed
            ? "Clock advance or delayed wake missed this occurrence; no catch-up work was launched"
            : overlapping && schedule.overlap === "skip"
              ? "The target worker still has pending or active work"
              : undefined;
          if (!reason) {
            try {
              const exists = Object.hasOwn(state.workers, schedule.target.worker);
              const template = schedule.template;
              if (
                exists &&
                template &&
                digestValue(state.workers[schedule.target.worker]) !== digestValue(template.worker)
              )
                throw new DomainError(
                  "conflict",
                  "Scheduled worker identity was accepted with a different frozen definition",
                );
              if (!exists && !template)
                throw new DomainError("conflict", "Scheduled frozen target is unavailable");
              let command: CommandEnvelope["command"];
              if (exists)
                command = {
                  kind: "follow_up",
                  worker: schedule.target.worker,
                  messageId: requestId,
                  text: schedule.task,
                  after: [],
                  inputs: [],
                };
              else {
                if (!template) throw new DomainError("conflict", "Missing schedule template");
                command = { kind: "add", workers: [{ ...template.request, messageId: requestId }] };
              }
              await this.host.validate(command, state);
              acceptance = prepareCommand(
                state,
                { requestId, command },
                this.options.caller,
                !exists && template ? { workers: [template.worker] } : {},
              );
              acceptance.payloadDigest = payloadDigest;
            } catch (error) {
              if (!(error instanceof DomainError)) throw error;
              reason = `Occurrence could not be accepted: ${error.message}`;
            }
          }
          const receipt = acceptance?.receipt ?? {
            status: "accepted" as const,
            requestId,
            revision: state.revision + 1,
            assignments: [],
            resolved: [],
          };
          await commit({
            kind: "schedule_occurrence",
            requestId,
            payloadDigest,
            receipt,
            scheduleId: schedule.id,
            occurrence: {
              scheduledAt: schedule.nextAt,
              status: acceptance ? "accepted" : missed ? "missed" : "skipped",
              ...(acceptance ? { ref: acceptance.assignments[0].ref } : { reason }),
              ...(missed ? { through: now } : {}),
            },
            nextAt,
            ...(localKey ? { lastLocalKey: localKey } : {}),
            ...(acceptance ? { acceptance } : {}),
          });
          // The host supplies a fresh state to each tick; accept at most one
          // occurrence per transaction so another schedule observes the new work.
          return true;
        }
        this.changed(state);
        return false;
      });
      if (!processed) return;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    await this.ticking;
    await this.host.transaction(async (state, commit) => {
      for (const schedule of Object.values(state.schedules)) {
        if (
          schedule.sessionId !== this.options.sessionId ||
          schedule.status === "closed" ||
          schedule.status === "deleted"
        )
          continue;
        const closed: ScheduleState = {
          ...schedule,
          revision: schedule.revision + 1,
          status: "closed",
          nextAt: null,
        };
        await commit(
          this.change(state, `schedule:${schedule.id}:close:${state.revision}`, "close", closed),
        );
        state = { ...state, revision: state.revision + 1 };
      }
    });
  }
}
