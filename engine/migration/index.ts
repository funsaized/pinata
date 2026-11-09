import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import { type ArtifactPort, sessionCheckpointSchema } from "../contracts/backend.ts";
import { type FrozenWorker } from "../contracts/commands.ts";
import {
  DomainError,
  type ArtifactRef,
  type CallerAuthority,
  type Grants,
} from "../contracts/common.ts";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import { type HistoricalProvenance } from "../contracts/history.ts";
import {
  type Assignment,
  type AssignmentResult,
  type HistoryImport,
} from "../contracts/lifecycle.ts";
import { workspacePlanSchema } from "../contracts/workspace.ts";
import { type Runtime } from "../runtime/index.ts";
import { digestBytes } from "../storage/io.ts";
import { convertDefinition, convertTask } from "./convert.ts";
import { inspectLegacyRun, readLegacyArtifact, type LegacyInspection } from "./read.ts";

export { migrationManifestSchema, type MigrationManifest } from "../contracts/migration.ts";
import { migrationManifestSchema, type MigrationManifest } from "../contracts/migration.ts";
export type MigrationPlan = {
  inspection: LegacyInspection;
  manifest: MigrationManifest;
  blockers: string[];
};

// Planning reads historical files only. It neither claims the source owner nor
// creates a replacement run, worktree, session, or authorization grant.
export async function planLegacyMigration(options: {
  source: string;
  run: string;
  workspace: string;
}): Promise<MigrationPlan> {
  const inspection = await inspectLegacyRun(options.source);
  if (inspection.run.id === options.run)
    throw new DomainError("invalid_input", "Migration requires a new run identity");
  const workspace = await realpath(options.workspace);
  const definitions: MigrationManifest["definitions"] = {};
  const blockers = [...inspection.blockers];
  const notices = [...inspection.notices];
  for (const assignment of inspection.assignments) {
    const task = assignment.task;
    const saved = task.definition ? inspection.run.definitions?.[task.definition] : undefined;
    if (!saved) {
      blockers.push(
        `Worker ${task.id} lacks an immutable legacy definition; inspect it with its matching executable.`,
      );
      continue;
    }
    const converted = convertDefinition(saved);
    const previous = definitions[task.id];
    if (previous && digestValue(previous) !== digestValue(converted.value))
      blockers.push(
        `Worker ${task.id} changed definitions in its history; an explicit replacement is required.`,
      );
    Object.defineProperty(definitions, task.id, {
      value: converted.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    notices.push(...converted.notices);
  }
  return {
    inspection,
    blockers: [...new Set(blockers)],
    manifest: migrationManifestSchema.parse({
      schemaVersion: 1,
      kind: "legacy-migration",
      source: {
        run: inspection.run.id,
        directory: inspection.directory,
        manifest: inspection.manifest,
      },
      destination: { run: options.run, workspace },
      inventoryDigest: inspection.inventoryDigest,
      files: inspection.files,
      preservedWorkspaces: inspection.workspaces,
      assignments: inspection.assignments.map(({ worker, assignment }) => ({
        run: options.run,
        worker,
        assignment,
      })),
      definitions,
      sessions: [],
      notices: [
        ...new Set(notices),
        "Imported pending or ambiguous assignments remain historical and require explicit continuation.",
        "Original stores, worktrees and references remain untouched; imported usage is not current accounting evidence.",
      ],
    }),
  };
}

function sourceGrants(
  manifest: MigrationManifest,
  inspection: LegacyInspection,
  worker: string,
): Grants {
  const definition = manifest.definitions[worker];
  if (!definition) throw new DomainError("invalid_input", "Missing converted definition");
  const access = inspection.run.allowWrites ? definition.pinata.access : "read";
  return {
    access,
    tools: definition.tools,
    workspaces: [definition.pinata.workspace],
    inheritContext: false,
    memory: { scope: "none", access: "read" },
    delegation: { maxDepth: 0, agents: [], tools: [], workspaces: [] },
  };
}

function historicalReason(
  status: string,
): Extract<Assignment["execution"], { phase: "ended" }>["reason"] {
  switch (status) {
    case "succeeded":
      return "completed";
    case "failed":
    case "rejected":
    case "blocked":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "interrupted";
  }
}

// Workers and optional imported session checkpoints come from a trusted host,
// after normal current definition/workspace validation. Model JSON cannot invoke
// this adapter or choose source permissions, old process identities, or paths.
export async function importLegacyRun(
  plan: MigrationPlan,
  options: {
    runtime: Runtime;
    caller: CallerAuthority;
    workers: FrozenWorker[];
    artifacts: ArtifactPort;
    sessions?: z.infer<typeof sessionCheckpointSchema>[];
    requestId: string;
  },
) {
  const manifest = migrationManifestSchema.parse(plan.manifest);
  if (plan.blockers.length)
    throw new DomainError("conflict", `Historical import is blocked: ${plan.blockers.join(" ")}`);
  const current = await inspectLegacyRun(manifest.source.directory);
  if (
    current.blockers.length ||
    current.inventoryDigest !== manifest.inventoryDigest ||
    current.manifest.digest !== manifest.source.manifest.digest
  )
    throw new DomainError(
      "conflict",
      "Historical source or ownership changed after migration planning",
    );
  if (options.caller.run !== manifest.destination.run)
    throw new DomainError(
      "capability_denied",
      "Migration destination differs from caller authority",
    );
  const bytesByDigest = new Map<string, Uint8Array>();
  const put = (bytes: Uint8Array): ArtifactRef => {
    const ref = { digest: digestBytes(bytes), size: bytes.length };
    bytesByDigest.set(ref.digest, Buffer.from(bytes));
    return ref;
  };
  const json = (value: unknown) => put(Buffer.from(canonicalJson(value)));
  for (const file of current.files) put(await readLegacyArtifact(current.directory, file));
  const workers: HistoryImport["workers"] = [];
  for (const worker of options.workers) {
    const definition = manifest.definitions[worker.id];
    const original = current.assignments.find((entry) => entry.worker === worker.id)?.task
      .definition;
    const savedDefinition = original ? current.run.definitions?.[original] : undefined;
    if (
      !savedDefinition ||
      digestValue(convertDefinition(savedDefinition).value) !== digestValue(definition)
    )
      throw new DomainError(
        "conflict",
        "Migration definition no longer matches its historical source",
      );
    if (!definition || worker.agent !== definition.name)
      throw new DomainError("conflict", "Migration worker does not match its converted definition");
    const expectedDefinition = json(definition);
    if (
      worker.definition.digest !== expectedDefinition.digest ||
      worker.definition.size !== expectedDefinition.size
    )
      throw new DomainError(
        "conflict",
        "Migration must use the exact converted immutable definition",
      );
    if (!worker.workspacePlan)
      throw new DomainError(
        "invalid_input",
        "Migration requires an explicitly selected current workspace plan",
      );
    const workspace = workspacePlanSchema.parse(
      JSON.parse(Buffer.from(await options.artifacts.read(worker.workspacePlan)).toString("utf8")),
    );
    if (
      workspace.run !== manifest.destination.run ||
      workspace.worker !== worker.id ||
      workspace.mode !== worker.workspace
    )
      throw new DomainError(
        "conflict",
        "Migrated workspace identity disagrees with the new worker",
      );
    if (workspace.mode === "shared") {
      if (
        workspace.source !== manifest.destination.workspace ||
        workspace.destination !== manifest.destination.workspace
      )
        throw new DomainError(
          "conflict",
          "Shared continuation requires the explicitly selected canonical checkout",
        );
    } else {
      if (
        !workspace.base ||
        !workspace.baseTree ||
        current.workspaces.includes(workspace.destination)
      )
        throw new DomainError(
          "conflict",
          "Isolated continuation requires a newly frozen snapshot and a new worktree path",
        );
      for (const old of [current.directory, ...current.workspaces]) {
        const child = relative(old, workspace.destination);
        if (
          child === "" ||
          (!isAbsolute(child) &&
            child !== ".." &&
            !child.startsWith("../") &&
            !child.startsWith("..\\"))
        )
          throw new DomainError(
            "conflict",
            "Migration cannot create a continuation inside retained historical evidence",
          );
      }
    }
    const first = current.assignments.find((entry) => entry.worker === worker.id);
    if (!first)
      throw new DomainError("invalid_input", "Migration worker lacks historical assignments");
    workers.push({
      worker,
      sourceGrants: sourceGrants(manifest, current, worker.id),
      provenance: provenance(first),
    });
  }
  function provenance(entry: LegacyInspection["assignments"][number]): HistoricalProvenance {
    return {
      kind: "legacy",
      run: current.run.id,
      store: current.directory,
      manifest: current.manifest,
      source: entry.source,
      sourceSchema: entry.sourceSchema,
      status: entry.status,
    };
  }
  const assignments: HistoryImport["assignments"] = current.assignments.map((entry, index) => {
    const ref = {
      run: manifest.destination.run,
      worker: entry.worker,
      assignment: entry.assignment,
    };
    const converted = convertTask(entry.task, { run: manifest.destination.run });
    const after = converted.after.map((item) => {
      if (typeof item !== "string") return item;
      const observed = current.events.find(
        (event) =>
          event.t === "agent_queued" &&
          event.agent === entry.worker &&
          (event.assignment ?? 1) === entry.assignment,
      );
      const exact =
        observed?.t === "agent_queued"
          ? observed.dependencies?.find((dependency) => dependency.worker === item)
          : undefined;
      if (exact) return { run: ref.run, ...exact };
      if (
        entry.assignment === 1 &&
        current.assignments.some((value) => value.worker === item && value.assignment === 1)
      )
        return { run: ref.run, worker: item, assignment: 1 };
      throw new DomainError(
        "conflict",
        "Legacy dependency lacks an exact observed assignment reference",
      );
    });
    const historical = provenance(entry);
    const assignment: Assignment = {
      ref,
      sequence: index + 1,
      task: converted.task,
      after,
      inputs: converted.inputs,
      context: converted.context,
      execution: { phase: "ended", reason: historicalReason(entry.status), cleanup: "confirmed" },
      historical,
    };
    const result: AssignmentResult = {
      ref,
      summary: entry.summary,
      execution: assignment.execution,
      historical,
      artifacts: current.files.map((file) => file.artifact),
      usage: {
        expectedAttempts: [],
        observations: [],
        complete: false,
        total: null,
        observedTotal: null,
        missingAttempts: [],
        issues: [],
        reason: "Legacy accounting is retained as historical evidence only",
      },
    };
    return { assignment, result, resultArtifact: json(result) };
  });
  const sessions = options.sessions ?? [];
  const source = json({ ...manifest, sessions });
  const observation = plan.inspection.quiescenceObservation
    ? json(plan.inspection.quiescenceObservation)
    : undefined;
  const quiescence = json({
    schemaVersion: 1,
    kind: "legacy-quiescence",
    sourceRun: current.run.id,
    sourceManifest: current.manifest,
    inventoryDigest: current.inventoryDigest,
    destinationRun: manifest.destination.run,
    owners: "absent",
    activity: current.quiescence,
    application: current.application,
    ...(observation ? { observation } : {}),
  });
  const request: HistoryImport = {
    requestId: options.requestId,
    source,
    quiescence,
    evidence: observation ? [observation] : [],
    workers,
    assignments,
    sessions,
  };
  // A final read closes the normal planning/copy race. Frozen artifacts stay
  // self-contained even if the retired store is later archived or removed.
  const final = await inspectLegacyRun(current.directory);
  if (final.blockers.length || final.inventoryDigest !== current.inventoryDigest)
    throw new DomainError("conflict", "Historical source changed while copying immutable evidence");
  return options.runtime.importHistory(request, options.caller, {
    async read(ref) {
      return bytesByDigest.get(ref.digest) ?? options.artifacts.read(ref);
    },
  });
}
