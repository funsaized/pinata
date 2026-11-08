import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DomainError, type ArtifactRef } from "../contracts/common.ts";
import { digestValue } from "../contracts/digest.ts";
import { digestBytes, isMissing } from "../storage/io.ts";
import { decodeLegacyApplicationJournal } from "../application/legacy.ts";
import { observeLegacyQuiescence, type LegacyQuiescenceObservation } from "./quiescence.ts";
import {
  parseLegacyEvents,
  parseLegacyRun,
  type LegacyEvent,
  type LegacyRun,
  type LegacyTask,
} from "./codecs.ts";

export type LegacyFile = {
  path: string;
  kind: "file" | "link";
  mode: number;
  artifact: ArtifactRef;
};
export type LegacyAssignment = {
  worker: string;
  assignment: number;
  task: LegacyTask;
  status: string;
  summary: string;
  sourceSchema: string;
  source: ArtifactRef;
  sequence?: number;
};
export type LegacyInspection = {
  directory: string;
  run: LegacyRun;
  events: LegacyEvent[];
  files: LegacyFile[];
  manifest: ArtifactRef;
  inventoryDigest: string;
  assignments: LegacyAssignment[];
  workspaces: string[];
  blockers: string[];
  notices: string[];
  quiescence: "stopped" | "never_started" | "unconfirmed";
  application: "none" | "reconciled" | "unconfirmed";
  quiescenceObservation?: LegacyQuiescenceObservation;
};

async function bytes(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new DomainError(
      "invalid_input",
      "Historical records must be regular files without links",
    );
  const content = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new DomainError("conflict", "Historical source changed while being inspected");
  return content;
}
const artifact = (content: Uint8Array): ArtifactRef => ({
  digest: digestBytes(content),
  size: content.length,
});

export async function readLegacyArtifact(
  directory: string,
  entry: LegacyFile,
): Promise<Uint8Array> {
  if (
    !entry.path ||
    entry.path.includes("\\") ||
    isAbsolute(entry.path) ||
    entry.path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new DomainError("invalid_input", "Historical artifact path escapes its source");
  let current = directory;
  const components = entry.path.split("/");
  for (const [index, part] of components.entries()) {
    current = join(current, part);
    const state = await lstat(current);
    if (index < components.length - 1 && (!state.isDirectory() || state.isSymbolicLink()))
      throw new DomainError("invalid_input", "Historical artifact parent traverses a link");
  }
  const content =
    entry.kind === "link" ? Buffer.from(await readlink(current)) : await bytes(current);
  if (content.length !== entry.artifact.size || digestBytes(content) !== entry.artifact.digest)
    throw new DomainError("conflict", `Historical artifact changed: ${entry.path}`);
  return content;
}

async function inventory(directory: string, excluded: string[]): Promise<LegacyFile[]> {
  const files: LegacyFile[] = [];
  async function visit(path: string, prefix: string): Promise<void> {
    if (excluded.includes(path)) return;
    for (const name of (await readdir(path)).sort()) {
      const current = join(path, name);
      if (excluded.includes(current)) continue;
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const state = await lstat(current);
      if (state.isSymbolicLink())
        files.push({
          path: relativePath,
          kind: "link",
          mode: state.mode & 0o777,
          artifact: artifact(Buffer.from(await readlink(current))),
        });
      else if (state.isDirectory()) await visit(current, relativePath);
      else if (state.isFile())
        files.push({
          path: relativePath,
          kind: "file",
          mode: state.mode & 0o777,
          artifact: artifact(await bytes(current)),
        });
      else
        throw new DomainError(
          "unsupported",
          `Historical store contains a non-file resource: ${relativePath}`,
        );
    }
  }
  await visit(directory, "");
  return files;
}

export async function inspectLegacyRun(source: string): Promise<LegacyInspection> {
  const directory = await realpath(source);
  if (!(await lstat(directory)).isDirectory())
    throw new DomainError("invalid_input", "Historical source is not a directory");
  const manifestBytes = await bytes(join(directory, "run.json"));
  const run = parseLegacyRun(JSON.parse(manifestBytes.toString("utf8")));
  let eventBytes: Buffer = Buffer.alloc(0);
  try {
    eventBytes = await bytes(join(directory, "events.jsonl"));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const events = parseLegacyEvents(eventBytes, run.id);
  const workspaces = [
    ...new Set(
      events
        .filter((event) => event.t === "agent_started" && event.workspace.kind === "worktree")
        .map((event) => (event.t === "agent_started" ? resolve(event.workspace.path) : "")),
    ),
  ];
  const excluded = workspaces.filter((path) => {
    const child = relative(directory, path);
    return (
      child !== "" &&
      !isAbsolute(child) &&
      child !== ".." &&
      !child.startsWith("../") &&
      !child.startsWith("..\\")
    );
  });
  const files = await inventory(directory, excluded);
  const again = await inventory(directory, excluded);
  const manifest = artifact(manifestBytes);
  if (
    digestValue(files) !== digestValue(again) ||
    files.find((file) => file.path === "run.json")?.artifact.digest !== manifest.digest ||
    (eventBytes.length &&
      files.find((file) => file.path === "events.jsonl")?.artifact.digest !==
        digestBytes(eventBytes))
  )
    throw new DomainError("conflict", "Historical source changed during inventory");
  const blockers: string[] = [];
  const notices: string[] = [
    "Historical statuses and verification retain their original schema and subject; they are not current acceptance.",
  ];
  for (const marker of ["coordinator.lock", "owner", "reconciling"]) {
    try {
      await lstat(join(directory, marker));
      blockers.push(
        `Legacy ownership marker ${marker} requires its matching executable; migration never removes it.`,
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const byWorker = new Map(run.tasks.map((task) => [task.id, task]));
  const assignments = new Map<string, LegacyAssignment>();
  for (const task of run.tasks)
    assignments.set(`${task.id}/1`, {
      worker: task.id,
      assignment: 1,
      task,
      status: "queued",
      summary: "Historical accepted work; execution was not observed",
      sourceSchema: "pinata.run.v3",
      source: manifest,
    });
  const eventsArtifact = artifact(eventBytes);
  for (const event of events) {
    if (event.t === "run_started") for (const task of event.tasks) byWorker.set(task.id, task);
    if (event.t === "agent_queued" && event.task) byWorker.set(event.task.id, event.task);
    const worker = event.agent;
    if (!worker) continue;
    const task = (event.t === "agent_queued" ? event.task : undefined) ?? byWorker.get(worker);
    if (!task)
      throw new DomainError(
        "invalid_input",
        `Legacy event names a worker without a saved task: ${worker}`,
      );
    const assignment = event.assignment ?? 1;
    const key = `${worker}/${assignment}`;
    const previous = assignments.get(key) ?? {
      worker,
      assignment,
      task,
      status: "queued",
      summary: "Historical accepted work; execution was not observed",
      sourceSchema: `pinata.event.v${event.v}`,
      source: eventsArtifact,
      sequence: event.seq,
    };
    if (["agent_queued", "agent_started", "agent_settled"].includes(event.t)) {
      const status =
        event.t === "agent_settled"
          ? event.status
          : event.t === "agent_started"
            ? "running"
            : "queued";
      assignments.set(key, {
        ...previous,
        task,
        status,
        summary: event.t === "agent_settled" ? event.summary : previous.summary,
        sourceSchema: `pinata.event.v${event.v}`,
        source: eventsArtifact,
        sequence: event.seq,
      });
    }
  }
  const activity =
    events.some((event) => event.t === "run_started" || event.t === "agent_started") ||
    files.some((file) => /(?:^|\/)pid\.json$|(?:^|\/)pane\.json$/.test(file.path));
  const observed =
    activity || run.resume?.owner
      ? await observeLegacyQuiescence(directory, run, events, workspaces)
      : undefined;
  const quiescence = observed
    ? observed.blockers.length
      ? "unconfirmed"
      : "stopped"
    : "never_started";
  if (observed) blockers.push(...observed.blockers);
  if (events.some((event) => event.v === 1))
    notices.push(
      "Schema-1 records without assignment IDs retain their observed first-assignment identity; no missing historical assignments are invented.",
    );
  let application: LegacyInspection["application"] = "none";
  const applicationFile = files.find((file) => file.path === "integration/journal.json");
  if (applicationFile) {
    const { journal } = decodeLegacyApplicationJournal(
      JSON.parse(
        Buffer.from(await readLegacyArtifact(directory, applicationFile)).toString("utf8"),
      ),
    );
    const terminal = !["applying", "rolling_back", "verifying"].includes(journal.status);
    const cursor = files.find((file) => file.path === "integration/snapshots.json");
    const expected =
      journal.status === "rolled_back" ? journal.previousSnapshots : journal.snapshots;
    const actual = cursor
      ? JSON.parse(Buffer.from(await readLegacyArtifact(directory, cursor)).toString("utf8"))
      : undefined;
    if (!terminal || !expected || digestValue(expected) !== digestValue(actual ?? null)) {
      application = "unconfirmed";
      blockers.push(
        "Legacy application phase/cursor evidence is pending or ambiguous; reconstruct it with the matching executable before writable migration.",
      );
    } else application = "reconciled";
  }
  return {
    directory,
    run,
    events,
    files,
    manifest,
    inventoryDigest: digestValue(files),
    assignments: [...assignments.values()].sort(
      (left, right) =>
        left.worker.localeCompare(right.worker) || left.assignment - right.assignment,
    ),
    workspaces,
    blockers,
    notices,
    quiescence,
    application,
    ...(observed ? { quiescenceObservation: observed.observation } : {}),
  };
}
