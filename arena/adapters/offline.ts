import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { AdapterRequest, AdapterResponse, ArenaTask, Unit } from "../types.ts";

export const OFFLINE_MODES = ["known-good", "noop", "broken", "repair-control"] as const;
export type OfflineMode = (typeof OFFLINE_MODES)[number];

type File = { bytes: Buffer; mode: number };
type Tree = Map<string, File>;
type Event = AdapterResponse["events"][number];
type Stage = { unit: Unit; before: Tree; after: Tree; changed: string[] };

function safePath(file: string): string {
  if (
    !file ||
    isAbsolute(file) ||
    file.includes("\\") ||
    file.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error(`Unsafe candidate path: ${file}`);
  }
  return file;
}

async function tree(root: string, prefix = ""): Promise<Tree> {
  const files: Tree = new Map();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (!prefix && entry.name === ".git") continue;
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    safePath(file);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are unsupported in controls: ${file}`);
    if (entry.isDirectory()) {
      for (const [name, data] of await tree(root, file)) files.set(name, data);
    } else if (entry.isFile()) {
      const path = join(root, file);
      files.set(file, { bytes: await readFile(path), mode: (await stat(path)).mode & 0o777 });
    } else {
      throw new Error(`Unsupported candidate entry: ${file}`);
    }
  }
  return files;
}

function same(a: File | undefined, b: File | undefined): boolean {
  return a === b || (!!a && !!b && a.mode === b.mode && a.bytes.equals(b.bytes));
}

function changes(before: Tree, after: Tree): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => !same(before.get(file), after.get(file)))
    .sort();
}

async function put(root: string, name: string, file: File | undefined): Promise<void> {
  const path = join(root, safePath(name));
  if (!file) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.bytes);
  await chmod(path, file.mode);
}

async function materialize(root: string, files: Tree): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [name, file] of files) await put(root, name, file);
}

function digest(file: File | undefined): string | null {
  return file ? createHash("sha256").update(file.bytes).digest("hex") : null;
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Deterministic harness controls, never a Piñata or model performance measurement. */
export async function executeOffline(
  request: AdapterRequest,
  task: ArenaTask,
  mode: OfflineMode = "known-good",
): Promise<AdapterResponse> {
  const events: Event[] = [];
  let attempts = 0;
  let repairs = 0;
  const root = join(request.evidenceDir, "offline");
  const limitations = [
    `Scripted offline control: ${mode}; no model or framework agent was invoked.`,
    "Known-good files are trusted controller resources, unavailable in candidate checkouts.",
    "Review compares owned files with reference bytes; this is not independent model review.",
    "Timings measure local file operations and harness scheduling, not Piñata or model performance.",
    "Copied unit directories provide file isolation, not an OS security sandbox.",
  ];
  if (mode === "repair-control") {
    limitations.push(
      "Artificial repair control: a planted defect is repaired from the reference only in review workflows. Group separately; this does not demonstrate reviewer capability or workflow superiority.",
    );
  }
  const response = (status: AdapterResponse["status"]): AdapterResponse => ({
    schemaVersion: 1,
    status,
    framework: { name: "scripted-control", version: "1" },
    model: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, source: "scripted; no API calls" },
    attempts,
    repairs,
    events,
    limitations,
  });
  // Serial writes retain event order even when unit stages execute concurrently.
  let evidenceWrites = Promise.resolve();
  let evidenceReady = false;
  const event = (entry: Event) => {
    events.push(entry);
    if (evidenceReady) {
      evidenceWrites = evidenceWrites.then(() => json(join(root, "events.json"), events));
    }
  };

  try {
    const evidenceRelative = relative(
      await realpath(request.cwd),
      await realpath(request.evidenceDir),
    );
    if (
      !evidenceRelative ||
      (evidenceRelative !== ".." &&
        !evidenceRelative.startsWith(`..${sep}`) &&
        !isAbsolute(evidenceRelative))
    ) {
      throw new Error("Evidence directory must be outside the candidate checkout");
    }
    await mkdir(root, { recursive: false });
    evidenceReady = true;
    event({
      stage: "control",
      status: "started",
      detail: `mode=${mode}; workflow=${request.workflow}`,
    });
    if (!OFFLINE_MODES.includes(mode)) throw new Error(`Unknown offline mode: ${mode}`);
    if (request.task.id !== task.id || request.task.version !== task.version) {
      throw new Error("Adapter request does not match the controller task");
    }
    const ids = new Set<string>();
    for (const unit of task.units) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(unit.id) || ids.has(unit.id)) {
        throw new Error(`Invalid or duplicate unit ID: ${unit.id}`);
      }
      ids.add(unit.id);
      for (const file of unit.files) safePath(file);
    }
    const initial = await tree(request.cwd);
    const reference = await tree(task.solutionDir);
    await json(join(root, "control.json"), {
      schemaVersion: 1,
      mode,
      workflow: request.workflow,
      model: null,
      apiCalls: 0,
      startingRevision: request.startingRevision,
      limitations,
    });
    const review = request.workflow.endsWith("-review");
    const parallel = request.workflow.startsWith("parallel");
    const stage = async (unit: Unit, before: Tree, index: number): Promise<Stage> => {
      const started = performance.now();
      const dir = join(root, "stages", unit.id);
      const worktree = join(dir, "worktree");
      event({ stage: "builder", unit: unit.id, status: "started" });
      attempts += 1;
      try {
        await materialize(worktree, before);
        if (mode !== "noop") {
          for (const file of unit.files) {
            const expected = reference.get(file);
            if (!expected) throw new Error(`Reference file missing for ${unit.id}: ${file}`);
            await put(worktree, file, expected);
          }
          if (
            (mode === "broken" || mode === "repair-control") &&
            index === 0 &&
            unit.files.length
          ) {
            const file = unit.files[0]!;
            await put(worktree, file, {
              bytes: Buffer.from('throw new Error("arena scripted planted defect");\n'),
              mode: reference.get(file)!.mode,
            });
          }
        }
        let after = await tree(worktree);
        const built = changes(before, after);
        await materialize(
          join(dir, "builder-output"),
          new Map(built.filter((file) => after.has(file)).map((file) => [file, after.get(file)!])),
        );
        await json(join(dir, "builder.json"), {
          mode,
          changed: built.map((file) => ({
            file,
            before: digest(before.get(file)),
            after: digest(after.get(file)),
          })),
        });
        event({
          stage: "builder",
          unit: unit.id,
          status: "completed",
          elapsedMs: performance.now() - started,
          detail: mode === "noop" ? "Scripted no edits" : "Scripted reference-file copy",
        });
        if (review) {
          const reviewStarted = performance.now();
          event({ stage: "review", unit: unit.id, status: "started" });
          const differences = unit.files.filter(
            (file) => !same(after.get(file), reference.get(file)),
          );
          await json(join(dir, "review.json"), {
            method: "scripted reference-byte comparison",
            differences,
            repairEnabled: mode === "repair-control" && request.limits.maxRepairs > 0,
          });
          event({
            stage: "review",
            unit: unit.id,
            status: differences.length ? "differences-found" : "passed",
            elapsedMs: performance.now() - reviewStarted,
            detail: `${differences.length} reference differences; scripted verification`,
          });
          if (differences.length && mode === "repair-control" && request.limits.maxRepairs > 0) {
            const repairStarted = performance.now();
            event({ stage: "repair", unit: unit.id, status: "started" });
            repairs += 1;
            attempts += 1;
            for (const file of differences) {
              const expected = reference.get(file);
              if (!expected) throw new Error(`Reference file missing for repair: ${file}`);
              await put(worktree, file, expected);
            }
            after = await tree(worktree);
            await json(join(dir, "repair.json"), {
              method: "scripted reference-file replacement",
              files: differences,
              verified: differences.every((file) => same(after.get(file), reference.get(file))),
            });
            event({
              stage: "repair",
              unit: unit.id,
              status: "completed",
              elapsedMs: performance.now() - repairStarted,
            });
          }
        }
        const changed = changes(before, after);
        const outside = changed.filter((file) => !unit.files.includes(file));
        if (outside.length)
          throw new Error(`Unit ${unit.id} changed unowned files: ${outside.join(", ")}`);
        await json(join(dir, "handoff.json"), {
          unit: unit.id,
          ownership: unit.files,
          changed: changed.map((file) => ({
            file,
            before: digest(before.get(file)),
            after: digest(after.get(file)),
          })),
        });
        event({
          stage: "handoff",
          unit: unit.id,
          status: "completed",
          detail: `${changed.length} changed files`,
        });
        return { unit, before, after, changed };
      } catch (error) {
        event({ stage: "unit", unit: unit.id, status: "failed", detail: String(error) });
        await mkdir(dir, { recursive: true });
        await json(join(dir, "failure.json"), { error: String(error) });
        throw error;
      }
    };

    const stages: Stage[] = [];
    if (parallel) {
      // Wait for every sibling so failed runs retain complete stage evidence.
      const results = await Promise.allSettled(
        task.units.map((unit, index) => stage(unit, initial, index)),
      );
      for (const result of results) if (result.status === "fulfilled") stages.push(result.value);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } else {
      const prior = new Map(initial);
      for (const [index, unit] of task.units.entries()) {
        const result = await stage(unit, new Map(prior), index);
        stages.push(result);
        for (const file of result.changed) {
          const value = result.after.get(file);
          if (value) prior.set(file, value);
          else prior.delete(file);
        }
      }
    }

    const integrationStarted = performance.now();
    event({ stage: "integration", status: "started" });
    try {
      const owners = new Map<string, string>();
      const merged = new Map(initial);
      for (const result of stages) {
        for (const file of result.unit.files) {
          const owner = owners.get(file);
          if (owner)
            throw new Error(`Overlapping file ownership: ${file} (${owner}, ${result.unit.id})`);
          owners.set(file, result.unit.id);
        }
        for (const file of result.changed) {
          if (!same(merged.get(file), result.before.get(file)))
            throw new Error(`Integration conflict: ${file}`);
          const value = result.after.get(file);
          if (value) merged.set(file, value);
          else merged.delete(file);
        }
      }
      if (changes(initial, await tree(request.cwd)).length)
        throw new Error("Candidate changed during unit execution");
      const changed = changes(initial, merged);
      await json(join(root, "integration.json"), {
        changed,
        ownership: Object.fromEntries(owners),
      });
      try {
        for (const file of changed) await put(request.cwd, file, merged.get(file));
      } catch (error) {
        for (const file of changed) await put(request.cwd, file, initial.get(file));
        throw error;
      }
      event({
        stage: "integration",
        status: "completed",
        elapsedMs: performance.now() - integrationStarted,
        detail: `${changed.length} changed files`,
      });
    } catch (error) {
      event({
        stage: "integration",
        status: "failed",
        elapsedMs: performance.now() - integrationStarted,
        detail: String(error),
      });
      throw error;
    }
    event({ stage: "control", status: "completed", detail: `mode=${mode}` });
    await evidenceWrites;
    return response("completed");
  } catch (error) {
    event({ stage: "control", status: "failed", detail: String(error) });
    // The response still exposes failures when creating evidence itself is impossible.
    await evidenceWrites.catch(() => undefined);
    return response("failed");
  }
}
