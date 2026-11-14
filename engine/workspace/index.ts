import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  artifactRefSchema,
  canonicalJson,
  configSchema,
  digestValue,
  DomainError,
  PreparationFailure,
  workspacePlanSchema,
  workspaceSnapshotSchema,
  type ArtifactPort,
  type ArtifactRef,
  type AssignmentRef,
  type CleanupReceipt,
  type PreparedWorkspace,
  type WorkspaceCapture,
  type WorkspaceManifest,
  type WorkspacePlan,
  type WorkspacePort,
  type WorkspaceRequest,
  type Worktree,
} from "../contracts/index.ts";
import { ApplicationStore } from "../application/index.ts";
import {
  digestBytes,
  isMissing,
  replaceProjection,
  syncDirectory,
  type FaultHook,
} from "../storage/io.ts";
import { captureManifest, readManifest, writeTree } from "./capture.ts";
import { GitCommands, gitLine } from "./git.ts";
import { WorkspaceOperations } from "./operations.ts";
import { resolveSetup, setupKey, SetupJournal } from "./setup.ts";
import {
  copyIncluded,
  freezeIncluded,
  includeIntent,
  observeIncluded,
  readIncluded,
} from "./include.ts";
import { completionCheckpoint, retainWorktreeHead, workspaceRefPrefix } from "./checkpoints.ts";
import { canonicalWorkspace, workspacePath } from "./paths.ts";
import { repository } from "./location.ts";
import { manifestAtTree } from "./tree.ts";

const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  plan: artifactRefSchema,
  root: z.string(),
  phase: z.enum(["metadata", "materializing", "ready"]),
  base: artifactRefSchema,
  baseTree: z.string(),
  baseCommit: z.string(),
  gitDirectory: z.string().optional(),
  checkpoint: z.enum(["completion", "none"]).optional(),
});
type WorkspaceRecord = z.infer<typeof recordSchema>;

export type WorkspaceOptions = {
  root: string;
  storeDirectory: string;
  worktreeRoot?: string;
  includeUncommitted?: boolean;
  nodeCommand?: string;
  fault?: FaultHook;
};

async function plannedPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return join(await plannedPath(dirname(path)), path.slice(dirname(path).length + 1));
  }
}

function emptyManifest(current: WorkspaceManifest): WorkspaceManifest {
  return {
    ...current,
    entries: [],
    observation: {
      ...current.observation,
      fingerprint: digestValue({ entries: [], repository: current.repository ?? null }),
      scope: ["empty base; shared state has no exclusive worker attribution"],
    },
  };
}

export class WorkspaceLayer implements WorkspacePort {
  private readonly options: WorkspaceOptions;
  constructor(options: WorkspaceOptions) {
    this.options = options;
  }

  private scope(artifacts: ArtifactPort, ownerEpoch: string, ref?: AssignmentRef): GitCommands {
    return new GitCommands({
      directory: join(
        this.options.storeDirectory,
        "workspace-helpers",
        ...(ref ? [digestValue(ref)] : []),
      ),
      ownerEpoch,
      artifacts,
      nodeCommand: this.options.nodeCommand,
    });
  }
  private recordDirectory(run: string, worker: string): string {
    return join(this.options.storeDirectory, "workspaces", digestValue({ run, worker }));
  }
  private operations(
    ref: AssignmentRef,
    ownerEpoch: string,
    artifacts: ArtifactPort,
  ): WorkspaceOperations {
    return new WorkspaceOperations({
      directory: this.recordDirectory(ref.run, ref.worker),
      helperRoot: join(this.options.storeDirectory, "workspace-helpers", digestValue(ref)),
      ref,
      ownerEpoch,
      artifacts,
      fault: this.options.fault,
    });
  }

  async freeze(
    request: { run: string; worker: string; mode: "shared" | "worktree" },
    artifacts: ArtifactPort,
    signal?: AbortSignal,
  ): Promise<ArtifactRef> {
    const root = await canonicalWorkspace(this.options.root);
    if (request.mode === "shared")
      return artifacts.put(
        Buffer.from(
          canonicalJson(
            workspacePlanSchema.parse({
              schemaVersion: 1,
              mode: "shared",
              source: root,
              destination: root,
              run: request.run,
              worker: request.worker,
            }),
          ),
        ),
      );
    const git = this.scope(artifacts, `freeze-${randomUUID()}`);
    try {
      const repo = await repository(root, git, signal);
      if (!repo || repo.root !== root)
        throw new DomainError(
          "unsupported",
          "Worktree isolation requires selecting a Git repository root",
        );
      const manifest =
        this.options.includeUncommitted === false
          ? await manifestAtTree(root, repo.head, git, artifacts, signal)
          : await captureManifest(root, git, artifacts, { signal });
      if (manifest.observation.status !== "stable")
        throw new DomainError(
          "conflict",
          "Workspace changed during base capture; retry after the edits settle",
        );
      const base = await artifacts.put(Buffer.from(canonicalJson(manifest)));
      const baseTree = await writeTree(root, manifest, git, artifacts, signal);
      const parent = await plannedPath(
        resolve(this.options.worktreeRoot ?? join(repo.commonDirectory, "pinata", "worktrees")),
      );
      const plan: WorkspacePlan = {
        schemaVersion: 1,
        mode: "worktree",
        source: root,
        destination: join(
          parent,
          digestValue({ run: request.run, worker: request.worker }).slice(0, 32),
        ),
        run: request.run,
        worker: request.worker,
        base,
        baseTree,
        repository: repo,
      };
      const includedFiles = await freezeIncluded(root, git, artifacts, signal);
      if (includedFiles) plan.includedFiles = includedFiles;
      return await artifacts.put(Buffer.from(canonicalJson(plan)));
    } finally {
      const cleanup = await git.close();
      if (cleanup.status !== "stopped")
        throw new DomainError(
          "owner_unconfirmed",
          `Base capture helper cleanup is unconfirmed: ${cleanup.reasons.join("; ")}`,
        );
    }
  }

  private async loadPlan(
    request: Pick<WorkspaceRequest, "ref" | "worker" | "artifacts">,
  ): Promise<{ plan: WorkspacePlan; artifact: ArtifactRef }> {
    const artifact = request.worker.workspacePlan;
    if (!artifact)
      throw new DomainError("context_unavailable", "Worker has no frozen workspace plan");
    const plan = workspacePlanSchema.parse(
      JSON.parse(Buffer.from(await request.artifacts.read(artifact)).toString("utf8")),
    );
    const root = await canonicalWorkspace(this.options.root);
    if (
      plan.run !== request.ref.run ||
      plan.worker !== request.ref.worker ||
      plan.mode !== request.worker.workspace ||
      plan.source !== root
    )
      throw new DomainError(
        "capability_denied",
        "Workspace plan differs from the accepted worker and authorized root",
      );
    if (plan.mode === "shared" && plan.destination !== root)
      throw new DomainError("capability_denied", "Shared workspace cannot relocate the worker");
    if ((await plannedPath(plan.destination)) !== plan.destination)
      throw new DomainError(
        "conflict",
        "Planned workspace path now resolves through a different alias",
      );
    return { plan, artifact };
  }

  private async saveRecord(
    request: WorkspaceRequest,
    record: WorkspaceRecord,
  ): Promise<ArtifactRef> {
    const artifact = await request.artifacts.put(Buffer.from(canonicalJson(record)));
    await replaceProjection(
      join(this.recordDirectory(request.ref.run, request.ref.worker), "current.json"),
      Buffer.from(canonicalJson(record)),
      "workspace-record",
      this.options.fault,
    );
    return artifact;
  }

  async prepare(request: WorkspaceRequest, signal: AbortSignal): Promise<PreparedWorkspace> {
    signal.throwIfAborted();
    const { plan, artifact } = await this.loadPlan(request);
    for (const input of request.inputs)
      if (!input.result.snapshot)
        throw new DomainError(
          "dependency_missing",
          `Workspace snapshot input is unavailable: ${input.ref.worker}/${input.ref.assignment}. inputs composes file snapshots, not reports. Query the upstream result/conversation and pass report text in context; use after only for ordering.`,
        );
    const operations = this.operations(request.ref, request.ownerEpoch, request.artifacts);
    const retained: ArtifactRef[] = [artifact, await operations.initialize(artifact)];
    let git: GitCommands | undefined;
    let worktree: Worktree | undefined;
    let helperCleanup: CleanupReceipt = {
      status: "stopped",
      ownerEpoch: request.ownerEpoch,
      identities: [],
      evidence: [],
    };
    const prepared = (): PreparedWorkspace => ({
      cwd: plan.destination,
      identity: digestValue({ plan: artifact, ref: request.ref }),
      artifacts: [...retained],
      ...(worktree ? { worktree } : {}),
    });
    try {
      if (plan.mode === "worktree") {
        let record: WorkspaceRecord | undefined;
        try {
          record = recordSchema.parse(
            JSON.parse(
              await readFile(
                join(this.recordDirectory(request.ref.run, request.ref.worker), "current.json"),
                "utf8",
              ),
            ),
          );
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        if (record) {
          if (
            record.phase !== "ready" ||
            digestValue(record.plan) !== digestValue(artifact) ||
            record.root !== plan.destination
          )
            throw new DomainError(
              "context_unavailable",
              "Worktree preparation is incomplete or belongs to another plan; inspect retained evidence before continuing",
            );
          await canonicalWorkspace(record.root);
          git = this.scope(request.artifacts, request.ownerEpoch, request.ref);
          await operations.retainHelper("continuation", git);
          const current = await repository(record.root, git, signal);
          if (
            !current ||
            current.root !== record.root ||
            current.commonDirectory !== plan.repository?.commonDirectory ||
            current.gitDirectory !== record.gitDirectory
          )
            throw new DomainError(
              "context_unavailable",
              "Retained worktree Git identity changed; reconcile it before continuation",
            );
          await git.run(record.root, ["cat-file", "-e", `${record.baseCommit}^{commit}`], {
            signal,
          });
          worktree = {
            plan: artifact,
            path: record.root,
            gitDirectory: current.gitDirectory,
            base: record.baseCommit,
          };
          helperCleanup = await operations.closeHelper(git);
          retained.push(...helperCleanup.evidence);
          if (helperCleanup.status !== "stopped")
            throw new DomainError(
              "owner_unconfirmed",
              "Continuation helper cleanup is unconfirmed",
            );
          git = undefined;
        } else {
          if (request.ref.assignment !== 1)
            throw new DomainError(
              "context_unavailable",
              "The prior worker workspace record is missing; no empty replacement will be created",
            );
          if (!plan.base || !plan.baseTree || !plan.repository)
            throw new DomainError("invalid_input", "Isolated plan has no immutable base");
          try {
            await lstat(plan.destination);
            throw new DomainError(
              "conflict",
              "Planned worktree path already exists without a matching worker record",
            );
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
          const base = await readManifest(plan.base, request.artifacts);
          git = this.scope(request.artifacts, request.ownerEpoch, request.ref);
          await operations.retainHelper("provision", git);
          const baseTree = await writeTree(plan.source, base, git, request.artifacts, signal);
          if (baseTree !== plan.baseTree)
            throw new DomainError(
              "conflict",
              "Frozen workspace tree no longer matches its manifest",
            );
          const baseCommit = gitLine(
            (
              await git.run(
                plan.source,
                [
                  "commit-tree",
                  baseTree,
                  ...(plan.repository.head ? ["-p", plan.repository.head] : []),
                ],
                {
                  input: `Pinata immutable base for ${request.ref.worker}\n`,
                  signal,
                  env: {
                    GIT_AUTHOR_NAME: "Pinata",
                    GIT_AUTHOR_EMAIL: "pinata@localhost",
                    GIT_COMMITTER_NAME: "Pinata",
                    GIT_COMMITTER_EMAIL: "pinata@localhost",
                  },
                },
              )
            ).stdout,
          );
          record = {
            schemaVersion: 1,
            plan: artifact,
            root: plan.destination,
            phase: "metadata",
            base: plan.base,
            baseTree,
            baseCommit,
          };
          retained.push(await this.saveRecord(request, record));
          await git.run(
            plan.source,
            ["update-ref", `${workspaceRefPrefix(request.ref)}/base`, baseCommit, ""],
            { signal },
          );
          await mkdir(dirname(plan.destination), { recursive: true, mode: 0o700 });
          await git.run(
            plan.source,
            ["worktree", "add", "--no-checkout", "--detach", plan.destination, baseCommit],
            { signal },
          );
          await this.options.fault?.("workspace.provision.metadata.after");
          helperCleanup = await operations.closeHelper(git);
          retained.push(...helperCleanup.evidence);
          if (helperCleanup.status !== "stopped")
            throw new DomainError(
              "owner_unconfirmed",
              "Worktree provisioning helper cleanup is unconfirmed",
            );
          git = undefined;
          record = { ...record, phase: "materializing" };
          retained.push(await this.saveRecord(request, record));
          await this.materialize(plan.destination, base, request.artifacts, signal);
          git = this.scope(request.artifacts, request.ownerEpoch, request.ref);
          await operations.retainHelper("index", git);
          const checkout = await repository(plan.destination, git, signal);
          if (!checkout || checkout.commonDirectory !== plan.repository.commonDirectory)
            throw new DomainError(
              "conflict",
              "Provisioned worktree belongs to a different repository",
            );
          // The real worktree index is initialized only when still absent. Source
          // index/HEAD and a concurrently created index are never replaced.
          const index = join(checkout.gitDirectory, "index");
          try {
            await lstat(index);
            throw new DomainError("conflict", "Worktree index appeared during provisioning");
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
          const privateIndex = join(checkout.gitDirectory, `.pinata-initial-index-${randomUUID()}`);
          await git.run(plan.destination, ["read-tree", baseTree], {
            signal,
            env: { GIT_INDEX_FILE: privateIndex },
          });
          const indexFile = await open(privateIndex, process.platform === "win32" ? "r+" : "r");
          try {
            await indexFile.sync();
          } finally {
            await indexFile.close();
          }
          await link(privateIndex, index);
          await syncDirectory(checkout.gitDirectory);
          await this.options.fault?.("workspace.provision.index.after");
          helperCleanup = await operations.closeHelper(git);
          retained.push(...helperCleanup.evidence);
          if (helperCleanup.status !== "stopped")
            throw new DomainError(
              "owner_unconfirmed",
              "Worktree index helper cleanup is unconfirmed",
            );
          git = undefined;
          if (plan.includedFiles) {
            git = this.scope(request.artifacts, request.ownerEpoch, request.ref);
            await operations.retainHelper("include", git);
            const intent = await includeIntent(
              {
                ref: request.ref,
                ownerEpoch: request.ownerEpoch,
                source: plan.source,
                destination: plan.destination,
                selection: plan.includedFiles,
              },
              request.artifacts,
            );
            retained.push(plan.includedFiles, intent.artifact);
            await operations.intendIncluded(intent.artifact);
            await this.options.fault?.("workspace.include.intent.after");
            const observation = await copyIncluded(intent.value, git, request.artifacts, {
              signal,
              fault: this.options.fault,
            });
            retained.push(observation);
            await operations.observeIncluded(observation);
            helperCleanup = await operations.closeHelper(git);
            retained.push(...helperCleanup.evidence);
            if (helperCleanup.status !== "stopped")
              throw new DomainError(
                "owner_unconfirmed",
                "Included-file helper cleanup is unconfirmed",
              );
            git = undefined;
          }
          retained.push(
            await this.saveRecord(request, {
              ...record,
              phase: "ready",
              gitDirectory: checkout.gitDirectory,
            }),
          );
          worktree = {
            plan: artifact,
            path: plan.destination,
            gitDirectory: checkout.gitDirectory,
            base: baseCommit,
          };
        }
      }
      // Explicit saved inputs use the same journaled application protocol. They
      // never infer acceptance from a predecessor's reported result.
      if (request.inputs.length) {
        const application = await ApplicationStore.open({
          destination: plan.destination,
          artifacts: request.artifacts,
          fault: this.options.fault,
        });
        try {
          for (const input of request.inputs) {
            if (!input.result.snapshot)
              throw new DomainError(
                "dependency_missing",
                `Workspace snapshot input is unavailable: ${input.ref.worker}/${input.ref.assignment}. inputs composes file snapshots, not reports. Query the upstream result/conversation and pass report text in context; use after only for ordering.`,
              );
            const operationId = `input-${digestValue({ target: request.ref, source: input.ref })}`;
            await operations.intendInput(operationId);
            const receipt = await application.applyInput({
              snapshot: input.result.snapshot,
              operationId,
            });
            retained.push(await request.artifacts.put(Buffer.from(canonicalJson(receipt))));
          }
          retained.push(
            await request.artifacts.put(Buffer.from(canonicalJson(await application.inspect()))),
          );
        } finally {
          const cleanup = await application.close();
          retained.push(...cleanup.evidence);
          if (cleanup.status !== "stopped") {
            helperCleanup = { ...cleanup, ownerEpoch: request.ownerEpoch };
            throw new DomainError(
              "owner_unconfirmed",
              "Input application helper cleanup is unconfirmed",
            );
          }
        }
      }
      if (plan.mode === "worktree" && request.worker.access === "write") {
        const config = request.worker.config
          ? configSchema.parse(
              JSON.parse(
                Buffer.from(await request.artifacts.read(request.worker.config)).toString("utf8"),
              ),
            )
          : configSchema.parse({});
        let selection = await resolveSetup(config.setup, plan.destination);
        const shellTool = process.platform === "win32" ? "powershell" : "bash";
        if (selection.command && !request.worker.grants.tools.includes(shellTool)) {
          retained.push(
            await request.artifacts.put(
              Buffer.from(
                canonicalJson({
                  kind: "workspace-setup-denied",
                  selection,
                  requiredTool: shellTool,
                }),
              ),
            ),
          );
          if (selection.source === "config")
            throw new DomainError(
              "capability_denied",
              `Explicit setup requires the worker's ${shellTool} tool capability`,
            );
          selection = {
            ...selection,
            command: null,
            reason: `Detected setup skipped because the worker lacks the ${shellTool} tool capability`,
          };
        }
        retained.push(
          await request.artifacts.put(
            Buffer.from(canonicalJson({ kind: "workspace-setup-selection", selection })),
          ),
        );
        if (selection.command) {
          const journal = new SetupJournal(
            join(this.recordDirectory(request.ref.run, request.ref.worker), "setup"),
            request.artifacts,
          );
          await journal.assertSettled();
          const prior = await journal.successful(setupKey(selection, config.passEnv));
          if (prior) retained.push(prior);
          else {
            git = this.scope(request.artifacts, request.ownerEpoch, request.ref);
            await operations.retainHelper("setup", git);
            const intent = await journal.create({
              ref: request.ref,
              ownerEpoch: request.ownerEpoch,
              selection,
              ...(request.worker.config ? { config: request.worker.config } : {}),
              cwd: plan.destination,
              sourceRoot: plan.source,
              helper: git.directory,
              passEnv: config.passEnv,
            });
            retained.push(intent.artifact);
            await operations.intendSetup(intent.artifact);
            await journal.publish(intent.value);
            await this.options.fault?.("workspace.setup.intent.after");
            const reply = await git.program(
              plan.destination,
              intent.value.program.executable,
              intent.value.program.args,
              {
                requestId: intent.value.requestId,
                passEnv: config.passEnv,
                sourceRoot: plan.source,
                signal,
                allowFailure: true,
              },
            );
            await this.options.fault?.("workspace.setup.command.after");
            helperCleanup = await operations.closeHelper(git);
            retained.push(...helperCleanup.evidence);
            if (helperCleanup.status !== "stopped")
              throw new DomainError("owner_unconfirmed", "Setup helper cleanup is unconfirmed");
            git = undefined;
            const outcome = await journal.complete(
              intent.value,
              intent.artifact,
              reply,
              helperCleanup,
            );
            retained.push(outcome.artifact, ...outcome.value.evidence);
            await this.options.fault?.("workspace.setup.outcome.after");
            await journal.markSuccessful(intent.value, outcome);
            if (outcome.value.state !== "completed")
              throw new DomainError(
                "context_unavailable",
                outcome.value.message ??
                  "Workspace setup failed; inspect retained command output and partial workspace",
              );
          }
        }
      }
      signal.throwIfAborted();
      await this.options.fault?.("workspace.prepare.ready");
      return prepared();
    } catch (cause) {
      if (git) {
        helperCleanup = await operations.closeHelper(git);
        retained.push(...helperCleanup.evidence);
      }
      if (helperCleanup.status === "stopped") {
        const latest = await operations.read();
        if (latest?.setup) {
          const journal = new SetupJournal(
            join(this.recordDirectory(request.ref.run, request.ref.worker), "setup"),
            request.artifacts,
          );
          try {
            retained.push(
              ...(await journal.recover(latest.setup, {
                ref: request.ref,
                ownerEpoch: request.ownerEpoch,
                cwd: plan.destination,
                sourceRoot: plan.source,
                helpers: latest.scopes.map((scope) => scope.directory),
                cleanup: helperCleanup,
              })),
            );
          } catch (error) {
            retained.push(
              await request.artifacts.put(
                Buffer.from(
                  canonicalJson({
                    kind: "setup-reconciliation-failed",
                    message: error instanceof Error ? error.message : String(error),
                  }),
                ),
              ),
            );
          }
        }
      }
      throw new PreparationFailure(
        cause instanceof Error ? cause.message : String(cause),
        { cleanup: helperCleanup, prepared: prepared(), artifacts: [...retained] },
        { cause },
      );
    }
  }

  async recover(
    request: Omit<WorkspaceRequest, "inputs"> & { prepared?: PreparedWorkspace },
    signal: AbortSignal,
  ): Promise<{ prepared?: PreparedWorkspace; cleanup: CleanupReceipt; artifacts: ArtifactRef[] }> {
    const { plan, artifact } = await this.loadPlan(request);
    const operations = this.operations(request.ref, request.ownerEpoch, request.artifacts);
    const record = await operations.read();
    if (!record) {
      if (request.prepared)
        throw new DomainError(
          "owner_unconfirmed",
          "Retained workspace preparation lost its operation evidence",
        );
      // The runtime persists prepare intent before invoking this layer. This
      // record is published before any helper or application is authorized.
      const evidence = await request.artifacts.put(
        Buffer.from(
          canonicalJson({
            kind: "workspace-preparation-not-authorized",
            ref: request.ref,
            ownerEpoch: request.ownerEpoch,
            plan: artifact,
          }),
        ),
      );
      return {
        cleanup: {
          status: "stopped",
          ownerEpoch: request.ownerEpoch,
          identities: [],
          evidence: [evidence],
        },
        artifacts: [artifact, evidence],
      };
    }
    if (digestValue(record.plan) !== digestValue(artifact))
      throw new DomainError(
        "owner_unconfirmed",
        "Workspace operation no longer matches its accepted plan",
      );
    const cleanup = await operations.recoverHelpers();
    if (cleanup.status !== "stopped") return { cleanup, artifacts: cleanup.evidence };
    const retained = [artifact, ...cleanup.evidence];
    if (record.included) {
      if (!plan.includedFiles)
        throw new DomainError("conflict", "Included-file preparation lacks its frozen selection");
      const observation = await observeIncluded(
        record.included.intent,
        {
          ref: request.ref,
          ownerEpoch: request.ownerEpoch,
          source: plan.source,
          destination: plan.destination,
          selection: plan.includedFiles,
        },
        request.artifacts,
      );
      await operations.observeIncluded(observation);
      retained.push(record.included.intent, ...record.included.observations, observation);
    }
    if (record.setup) {
      const journal = new SetupJournal(
        join(this.recordDirectory(request.ref.run, request.ref.worker), "setup"),
        request.artifacts,
      );
      retained.push(
        ...(await journal.recover(record.setup, {
          ref: request.ref,
          ownerEpoch: request.ownerEpoch,
          cwd: plan.destination,
          sourceRoot: plan.source,
          helpers: record.scopes.map((scope) => scope.directory),
          cleanup,
        })),
      );
    }
    let destinationExists = false;
    try {
      destinationExists = (await lstat(plan.destination)).isDirectory();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (destinationExists && record.inputs.length) {
      const application = await ApplicationStore.open({
        destination: plan.destination,
        artifacts: request.artifacts,
      });
      try {
        await application.reconcile(signal, { operationIds: record.inputs });
        retained.push(
          await request.artifacts.put(Buffer.from(canonicalJson(await application.inspect()))),
        );
      } finally {
        const stopped = await application.close();
        retained.push(...stopped.evidence);
        if (stopped.status !== "stopped")
          throw new DomainError(
            "owner_unconfirmed",
            "Recovered input application helpers remain unconfirmed",
          );
      }
    }
    let worktree: Worktree | undefined;
    if (destinationExists && plan.mode === "worktree") {
      try {
        const workspace = recordSchema.parse(
          JSON.parse(
            await readFile(
              join(this.recordDirectory(request.ref.run, request.ref.worker), "current.json"),
              "utf8",
            ),
          ),
        );
        if (
          workspace.root !== plan.destination ||
          digestValue(workspace.plan) !== digestValue(artifact)
        )
          throw new DomainError("conflict", "Recovered worktree differs from its accepted plan");
        if (workspace.phase === "ready" && workspace.gitDirectory)
          worktree = {
            plan: artifact,
            path: workspace.root,
            gitDirectory: workspace.gitDirectory,
            base: workspace.baseCommit,
          };
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return {
      ...(destinationExists
        ? {
            prepared: {
              cwd: plan.destination,
              identity: digestValue({ plan: artifact, ref: request.ref }),
              artifacts: retained,
              ...(worktree ? { worktree } : {}),
            },
          }
        : {}),
      cleanup: { ...cleanup, evidence: retained },
      artifacts: retained,
    };
  }

  private async materialize(
    root: string,
    manifest: WorkspaceManifest,
    artifacts: ArtifactPort,
    signal: AbortSignal,
  ): Promise<void> {
    for (const entry of manifest.entries) {
      signal.throwIfAborted();
      const path = await workspacePath(root, entry.path);
      await mkdir(dirname(path), { recursive: true });
      await workspacePath(root, entry.path);
      if (entry.mode === "160000") {
        await mkdir(path);
        continue;
      }
      const bytes = await artifacts.read(entry.blob);
      if (bytes.length !== entry.blob.size || digestBytes(bytes) !== entry.blob.digest)
        throw new DomainError("conflict", `Captured file bytes do not match ${entry.path}`);
      await this.options.fault?.(`workspace.file.${entry.path}.before`);
      if (entry.mode === "120000") await symlink(Buffer.from(bytes).toString("utf8"), path);
      else {
        const file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          entry.mode === "100755" ? 0o755 : 0o644,
        );
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      await syncDirectory(dirname(path));
      await this.options.fault?.(`workspace.file.${entry.path}.after`);
    }
  }

  async capture(
    request: Parameters<NonNullable<WorkspacePort["capture"]>>[0],
    signal: AbortSignal,
  ): Promise<WorkspaceCapture> {
    const { prepared, ref, cleanup } = request;
    if (cleanup.status !== "stopped")
      throw new DomainError(
        "owner_unconfirmed",
        "Workspace capture requires stopped worker activity",
      );
    return this.captureBound(prepared, ref, cleanup, request.artifacts, signal, request.reason);
  }

  private async captureBound(
    prepared: PreparedWorkspace,
    ref: AssignmentRef,
    cleanup: CleanupReceipt,
    artifacts: ArtifactPort,
    signal: AbortSignal,
    reason?: Parameters<NonNullable<WorkspacePort["capture"]>>[0]["reason"],
  ): Promise<WorkspaceCapture> {
    const operations = this.operations(ref, cleanup.ownerEpoch, artifacts);
    const priorCleanup = await operations.recoverHelpers();
    if (priorCleanup.status !== "stopped")
      throw new DomainError(
        "owner_unconfirmed",
        "Prior workspace helpers remain unconfirmed; capture cannot retry",
      );
    const git = this.scope(artifacts, cleanup.ownerEpoch, ref);
    await operations.retainHelper("capture", git);
    try {
      const operation = await operations.read();
      if (!operation)
        throw new DomainError("context_unavailable", "Capture has no retained workspace plan");
      const plan = workspacePlanSchema.parse(
        JSON.parse(Buffer.from(await artifacts.read(operation.plan)).toString()),
      );
      if (plan.destination !== prepared.cwd || plan.run !== ref.run || plan.worker !== ref.worker)
        throw new DomainError(
          "capability_denied",
          "Capture differs from its accepted workspace plan",
        );
      const excluded = plan.includedFiles
        ? await readIncluded(plan.includedFiles, plan.source, artifacts)
        : undefined;
      const manifest = await captureManifest(prepared.cwd, git, artifacts, {
        signal,
        excludePaths: excluded?.files.map((file) => file.path),
      });
      if (manifest.observation.status !== "stable")
        throw new DomainError(
          "conflict",
          "Workspace changed during final capture; retained edits need another observation",
        );
      const current = await artifacts.put(Buffer.from(canonicalJson(manifest)));
      let base: ArtifactRef;
      let baseTree: string | undefined;
      let mode: "shared" | "worktree" = "shared";
      let record: WorkspaceRecord | undefined;
      try {
        record = recordSchema.parse(
          JSON.parse(
            await readFile(join(this.recordDirectory(ref.run, ref.worker), "current.json"), "utf8"),
          ),
        );
        if (record.root !== prepared.cwd)
          throw new DomainError("conflict", "Captured workspace differs from retained worker path");
        if (record.phase !== "ready") return { artifacts: [...prepared.artifacts, current] };
        base = record.base;
        baseTree = record.baseTree;
        mode = "worktree";
      } catch (error) {
        if (!isMissing(error)) throw error;
        const original = manifest.repository
          ? await manifestAtTree(prepared.cwd, manifest.repository.head, git, artifacts, signal)
          : emptyManifest(manifest);
        base = await artifacts.put(Buffer.from(canonicalJson(original)));
      }
      const tree =
        manifest.repository && manifest.repository.root === prepared.cwd
          ? await writeTree(prepared.cwd, manifest, git, artifacts, signal)
          : undefined;
      const retained = [base, current];
      const errors: string[] = [];
      let head: Awaited<ReturnType<typeof retainWorktreeHead>> | undefined;
      let checkpoint: Awaited<ReturnType<typeof completionCheckpoint>> | undefined;
      if (mode === "worktree" && record && tree) {
        try {
          if (manifest.repository?.head)
            head = await retainWorktreeHead({
              ref,
              root: prepared.cwd,
              head: manifest.repository.head,
              git,
              signal,
            });
          if (reason === "completed" && record.checkpoint === "completion") {
            checkpoint = await completionCheckpoint({
              ref,
              root: prepared.cwd,
              directory: join(this.recordDirectory(ref.run, ref.worker), "checkpoints"),
              tree,
              base: { tree: record.baseTree, commit: record.baseCommit },
              git,
              artifacts,
              signal,
              fault: this.options.fault,
            });
            retained.push(checkpoint.artifact);
          }
        } catch (error) {
          errors.push(
            `Workspace checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const snapshot = workspaceSnapshotSchema.parse({
        schemaVersion: 1,
        kind: "workspace-snapshot",
        ref,
        root: prepared.cwd,
        mode,
        base,
        manifest: current,
        ...(baseTree ? { baseTree } : {}),
        ...(tree ? { tree } : {}),
        ...(head ? { head } : {}),
        ...(checkpoint ? { checkpoint: checkpoint.checkpoint } : {}),
      });
      return {
        snapshot: await artifacts.put(Buffer.from(canonicalJson(snapshot))),
        artifacts: retained,
        ...(errors.length ? { errors } : {}),
      };
    } finally {
      const stopped = await operations.closeHelper(git);
      if (stopped.status !== "stopped")
        throw new DomainError(
          "owner_unconfirmed",
          "Capture helper activity is unconfirmed; recover the workspace before continuing",
        );
    }
  }

  async release({
    ref,
    cleanup,
    artifacts,
  }: Parameters<WorkspacePort["release"]>[0]): Promise<void> {
    if (cleanup.status !== "stopped")
      throw new DomainError("owner_unconfirmed", "Worker cleanup is unconfirmed");
    const helpers = await this.operations(ref, cleanup.ownerEpoch, artifacts).recoverHelpers();
    if (helpers.status !== "stopped")
      throw new DomainError("owner_unconfirmed", "Workspace helper cleanup remains unconfirmed");
  }
}
