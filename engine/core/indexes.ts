import {
  assignmentKey,
  type Assignment,
  type AttemptState,
  type CoreState,
  type EffectState,
  type Transition,
} from "../contracts/index.ts";

export type ReadinessReason =
  | "ready"
  | "dependency"
  | "capacity"
  | "cancelled"
  | "active"
  | "cleanup_unconfirmed"
  | "effect_unconfirmed"
  | "ended";

type Entry = {
  readonly dependencies: readonly string[];
  readonly dependents: readonly string[];
  readonly attempts: readonly string[];
  readonly effects: readonly string[];
  readonly blocked: number;
  readonly unresolved: number;
};
type Buckets = readonly Readonly<Record<string, Entry>>[];
type Indexes = {
  readonly entries: Buckets;
  readonly ordered: readonly string[];
  readonly ready: readonly string[];
  readonly queued: readonly string[];
  readonly occupied: readonly string[];
  readonly cancelled: readonly string[];
};
const derived = Symbol("assignment indexes");
type IndexedState = CoreState & {
  [derived]?: {
    assignments: CoreState["assignments"];
    attempts: CoreState["attempts"];
    effects: CoreState["effects"];
    cancelled: CoreState["cancelled"];
    indexes: Indexes;
  };
};
const empty: Entry = Object.freeze({
  dependencies: Object.freeze([]),
  dependents: Object.freeze([]),
  attempts: Object.freeze([]),
  effects: Object.freeze([]),
  blocked: 0,
  unresolved: 0,
});
const emptyBucket = Object.freeze({});
const emptyBuckets: Buckets = Object.freeze(Array.from({ length: 64 }, () => emptyBucket));

function bucketFor(key: string): number {
  let hash = 5381;
  for (let index = 0; index < key.length; index++) hash = (hash * 33) ^ key.charCodeAt(index);
  return hash & 63;
}

function entryAt(buckets: Buckets, key: string): Entry {
  const bucket = buckets[bucketFor(key)];
  return Object.hasOwn(bucket, key) ? bucket[key] : empty;
}

function updateBuckets(buckets: Buckets, changes: Map<string, Entry>): Buckets {
  if (!changes.size) return buckets;
  const next = [...buckets];
  const copied = new Map<number, Record<string, Entry>>();
  for (const [key, entry] of changes) {
    const index = bucketFor(key);
    let bucket = copied.get(index);
    if (!bucket) {
      bucket = { ...buckets[index] };
      copied.set(index, bucket);
      next[index] = bucket;
    }
    Object.defineProperty(bucket, key, {
      enumerable: true,
      value: Object.freeze({
        ...entry,
        dependencies: Object.freeze(entry.dependencies),
        dependents: Object.freeze(entry.dependents),
        attempts: Object.freeze(entry.attempts),
        effects: Object.freeze(entry.effects),
      }),
    });
  }
  for (const bucket of copied.values()) Object.freeze(bucket);
  return Object.freeze(next);
}

function completed(assignment: Assignment | undefined): boolean {
  return assignment?.execution.phase === "ended" && assignment.execution.cleanup === "confirmed";
}

function occupied(assignment: Assignment): boolean {
  return assignment.execution.phase !== "queued" && !completed(assignment);
}

function condition(state: CoreState, key: string, entry: Entry): ReadinessReason {
  const assignment = state.assignments[key];
  if (assignment.execution.phase === "ended")
    return completed(assignment) ? "ended" : "cleanup_unconfirmed";
  if (Object.hasOwn(state.cancelled, key)) return "cancelled";
  if (assignment.execution.phase !== "queued") return "active";
  if (entry.unresolved) return "effect_unconfirmed";
  if (entry.blocked) return "dependency";
  return "ready";
}

function rebuild(state: CoreState): Indexes {
  const entries = new Map<string, Entry>();
  const ordered = Object.keys(state.assignments).sort(
    (left, right) => state.assignments[left].sequence - state.assignments[right].sequence,
  );
  for (const key of ordered) {
    const dependencies = state.assignments[key].after.map(assignmentKey);
    entries.set(key, {
      ...empty,
      dependencies,
      blocked: dependencies.filter((id) => !completed(state.assignments[id])).length,
    });
  }
  for (const [key, entry] of entries)
    for (const dependency of entry.dependencies) {
      const parent = entries.get(dependency) ?? empty;
      entries.set(dependency, { ...parent, dependents: [...parent.dependents, key] });
    }
  for (const [id, attempt] of Object.entries(state.attempts)) {
    const key = assignmentKey(attempt.attempt.ref);
    const entry = entries.get(key) ?? empty;
    entries.set(key, { ...entry, attempts: [...entry.attempts, id] });
  }
  for (const [key, entry] of entries)
    if (entry.attempts.length > 1)
      entries.set(key, {
        ...entry,
        attempts: [...entry.attempts].sort(
          (left, right) =>
            state.attempts[left].attempt.ordinal - state.attempts[right].attempt.ordinal,
        ),
      });
  for (const [id, effect] of Object.entries(state.effects)) {
    const key = assignmentKey(effect.effect.ref);
    const entry = entries.get(key) ?? empty;
    const unresolved = effect.status === "intent" || effect.status === "uncertain";
    entries.set(key, {
      ...entry,
      effects: [...entry.effects, id],
      unresolved: entry.unresolved + Number(unresolved),
    });
  }
  return Object.freeze({
    entries: updateBuckets(emptyBuckets, entries),
    ordered: Object.freeze(ordered),
    ready: Object.freeze(
      ordered.filter((key) => condition(state, key, entries.get(key) ?? empty) === "ready"),
    ),
    queued: Object.freeze(
      ordered.filter((key) => state.assignments[key].execution.phase === "queued"),
    ),
    occupied: Object.freeze(ordered.filter((key) => occupied(state.assignments[key]))),
    cancelled: Object.freeze(
      ordered.filter(
        (key) =>
          state.assignments[key].execution.phase === "queued" &&
          Object.hasOwn(state.cancelled, key),
      ),
    ),
  });
}

function indexes(state: IndexedState): Indexes {
  const saved = state[derived];
  if (
    saved &&
    saved.assignments === state.assignments &&
    saved.attempts === state.attempts &&
    saved.effects === state.effects &&
    saved.cancelled === state.cancelled
  )
    return saved.indexes;
  return rebuild(state);
}

function position(keys: readonly string[], state: CoreState, key: string): number {
  const sequence = state.assignments[key].sequence;
  let lower = 0;
  let upper = keys.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (state.assignments[keys[middle]].sequence < sequence) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function membership(
  keys: readonly string[],
  state: CoreState,
  key: string,
  present: boolean,
): readonly string[] {
  const index = position(keys, state, key);
  const exists = keys[index] === key;
  if (exists === present) return keys;
  const next = [...keys];
  if (present) next.splice(index, 0, key);
  else next.splice(index, 1);
  return Object.freeze(next);
}

// Derived data is local to each immutable projection. It is deliberately omitted
// by JSON and structuredClone; snapshots and checkpoints rebuild it from state.
export function indexTransition(state: CoreState, next: CoreState, input: Transition): CoreState {
  const previous = indexes(state);
  let value = previous;
  const transition = input.kind === "schedule_occurrence" ? input.acceptance : input;
  const changes = new Map<string, Entry>();
  const affected = new Set<string>();
  const read = (key: string) => changes.get(key) ?? entryAt(previous.entries, key);
  if (transition?.kind === "accepted") {
    const added = transition.assignments.map((assignment) => assignmentKey(assignment.ref));
    value = { ...value, ordered: Object.freeze([...value.ordered, ...added]) };
    for (const key of added) {
      const dependencies = next.assignments[key].after.map(assignmentKey);
      changes.set(key, {
        ...read(key),
        dependencies,
        blocked: dependencies.filter((id) => !completed(next.assignments[id])).length,
      });
      affected.add(key);
      for (const dependency of dependencies) {
        const parent = read(dependency);
        changes.set(dependency, { ...parent, dependents: [...parent.dependents, key] });
      }
    }
  }
  if (transition?.kind === "attempt_started") {
    const key = assignmentKey(transition.attempt.ref);
    const entry = read(key);
    changes.set(key, { ...entry, attempts: [...entry.attempts, transition.attempt.id] });
  }
  if (transition?.kind === "effect_intent") {
    const key = assignmentKey(transition.effect.ref);
    const entry = read(key);
    changes.set(key, {
      ...entry,
      effects: [...entry.effects, transition.effect.id],
      unresolved: entry.unresolved + 1,
    });
    affected.add(key);
  }
  if (transition?.kind === "effect_observed") {
    const key = assignmentKey(state.effects[transition.effectId].effect.ref);
    const entry = read(key);
    changes.set(key, {
      ...entry,
      unresolved: entry.unresolved - Number(transition.status !== "uncertain"),
    });
    affected.add(key);
  }
  if (transition?.kind === "control_accepted" && transition.action.kind === "cancel")
    for (const ref of transition.action.targets) affected.add(assignmentKey(ref));
  const changed =
    transition?.kind === "assignment_state"
      ? assignmentKey(transition.ref)
      : transition?.kind === "settled"
        ? assignmentKey(transition.result.ref)
        : transition?.kind === "cleanup_observed"
          ? assignmentKey(next.attempts[transition.attemptId].attempt.ref)
          : undefined;
  if (changed) {
    affected.add(changed);
    const difference =
      Number(completed(state.assignments[changed])) - Number(completed(next.assignments[changed]));
    if (difference)
      for (const key of read(changed).dependents) {
        const entry = read(key);
        changes.set(key, { ...entry, blocked: entry.blocked + difference });
        affected.add(key);
      }
  }
  for (const key of affected) {
    const assignment = next.assignments[key];
    const queued = assignment.execution.phase === "queued";
    value = {
      ...value,
      ready: membership(value.ready, next, key, condition(next, key, read(key)) === "ready"),
      queued: membership(value.queued, next, key, queued),
      occupied: membership(value.occupied, next, key, occupied(assignment)),
      cancelled: membership(
        value.cancelled,
        next,
        key,
        queued && Object.hasOwn(next.cancelled, key),
      ),
    };
  }
  value = Object.freeze({ ...value, entries: updateBuckets(previous.entries, changes) });
  const result = { ...next };
  Object.defineProperty(result, derived, {
    value: Object.freeze({
      assignments: next.assignments,
      attempts: next.attempts,
      effects: next.effects,
      cancelled: next.cancelled,
      indexes: value,
    }),
  });
  return result;
}

export function assignmentAttempts(state: CoreState, key: string): AttemptState[] {
  return entryAt(indexes(state).entries, key).attempts.map((id) => state.attempts[id]);
}

export function assignmentEffects(state: CoreState, key: string): EffectState[] {
  return entryAt(indexes(state).entries, key).effects.map((id) => state.effects[id]);
}

export function queuedAssignments(state: CoreState, cancelled = false): Assignment[] {
  const value = indexes(state);
  return (cancelled ? value.cancelled : value.queued).map((key) => state.assignments[key]);
}

export function hasQueuedAssignments(state: CoreState): boolean {
  return indexes(state).queued.length > 0;
}

export function occupiedCount(state: CoreState): number {
  return indexes(state).occupied.length;
}

export function occupiedAssignments(state: CoreState): Assignment[] {
  return indexes(state).occupied.map((key) => state.assignments[key]);
}

export function readiness(state: CoreState): Record<string, ReadinessReason> {
  const value = indexes(state);
  const reasons: Record<string, ReadinessReason> = {};
  let available =
    state.maxConcurrent === null
      ? Infinity
      : Math.max(0, state.maxConcurrent - value.occupied.length);
  for (const key of value.ordered) {
    const reason = condition(state, key, entryAt(value.entries, key));
    reasons[key] = reason === "ready" && available === 0 ? "capacity" : reason;
    if (reason === "ready" && available > 0) available--;
  }
  return reasons;
}

export function readinessFor(state: CoreState, key: string): ReadinessReason | undefined {
  if (!Object.hasOwn(state.assignments, key)) return undefined;
  const value = indexes(state);
  const reason = condition(state, key, entryAt(value.entries, key));
  if (reason !== "ready" || state.maxConcurrent === null) return reason;
  const available = Math.max(0, state.maxConcurrent - value.occupied.length);
  return position(value.ready, state, key) < available ? "ready" : "capacity";
}

export function readyAssignments(state: CoreState, limit = Infinity): Assignment[] {
  const value = indexes(state);
  const available =
    state.maxConcurrent === null
      ? Infinity
      : Math.max(0, state.maxConcurrent - value.occupied.length);
  return value.ready
    .slice(0, Math.max(0, Math.min(limit, available)))
    .map((key) => structuredClone(state.assignments[key]));
}
