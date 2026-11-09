import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  artifactRefSchema,
  assignmentRefSchema,
  canonicalJson,
  cleanupReceiptSchema,
  digestValue,
  DomainError,
  identitySchema,
  revisionSchema,
  textSchema,
  type ArtifactPort,
  type ArtifactRef,
  type AssignmentRef,
  type CleanupReceipt,
} from "../contracts/index.ts";
import { digestBytes, isMissing, publishImmutable, type FaultHook } from "../storage/io.ts";
import { GitCommands, recoverGitCleanup } from "./git.ts";

const operationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: revisionSchema,
  previousDigest: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{64}$/)]),
  ref: assignmentRefSchema,
  ownerEpoch: identitySchema,
  plan: artifactRefSchema,
  scopes: z.array(
    z.strictObject({
      phase: textSchema,
      directory: textSchema,
      cleanup: cleanupReceiptSchema.optional(),
    }),
  ),
  leases: z.array(z.strictObject({ id: identitySchema, workspace: textSchema })),
  inputs: z.array(identitySchema),
  setup: artifactRefSchema.optional(),
  included: z
    .strictObject({ intent: artifactRefSchema, observations: z.array(artifactRefSchema) })
    .optional(),
});
export type WorkspaceOperation = z.infer<typeof operationSchema>;

export class WorkspaceOperations {
  private readonly options: {
    directory: string;
    helperRoot: string;
    ref: AssignmentRef;
    ownerEpoch: string;
    artifacts: ArtifactPort;
    fault?: FaultHook;
  };
  constructor(options: WorkspaceOperations["options"]) {
    this.options = options;
  }

  private directory(): string {
    return join(this.options.directory, `${this.options.ref.assignment}-operations`);
  }

  private async assertKnownScopes(scopes: WorkspaceOperation["scopes"]): Promise<void> {
    let names: string[];
    try {
      const state = await lstat(this.options.helperRoot);
      if (!state.isDirectory() || state.isSymbolicLink())
        throw new DomainError("owner_unconfirmed", "Workspace helper root is not a real directory");
      names = await readdir(this.options.helperRoot);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (
      names.some(
        (name) => !scopes.some((scope) => scope.directory === join(this.options.helperRoot, name)),
      )
    )
      throw new DomainError(
        "owner_unconfirmed",
        "Workspace helper evidence has no retained authorization record",
      );
  }

  async read(): Promise<WorkspaceOperation | undefined> {
    let names: string[];
    try {
      if (!(await lstat(this.directory())).isDirectory())
        throw new DomainError(
          "owner_unconfirmed",
          "Workspace operation evidence is not a directory",
        );
      names = (await readdir(this.directory()))
        .filter((name) => !name.startsWith(".unaccepted-"))
        .sort();
    } catch (error) {
      if (isMissing(error)) {
        await this.assertKnownScopes([]);
        return undefined;
      }
      throw error;
    }
    let record: WorkspaceOperation | undefined;
    let previousDigest = "";
    for (const [revision, name] of names.entries()) {
      if (!/^\d{16}-[a-f0-9]{64}\.json$/.test(name) || Number(name.slice(0, 16)) !== revision)
        throw new DomainError(
          "owner_unconfirmed",
          "Workspace operation history is missing or unordered",
        );
      const path = join(this.directory(), name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        throw new DomainError(
          "owner_unconfirmed",
          "Workspace operation evidence is not a regular file",
        );
      const bytes = await readFile(path);
      const digest = digestBytes(bytes);
      if (digest !== name.slice(17, -5))
        throw new DomainError("owner_unconfirmed", "Workspace operation evidence changed");
      record = operationSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (record.revision !== revision || record.previousDigest !== previousDigest)
        throw new DomainError("owner_unconfirmed", "Workspace operation history is discontinuous");
      previousDigest = digest;
    }
    if (!record) {
      await this.assertKnownScopes([]);
      return undefined;
    }
    await this.assertKnownScopes(record.scopes);
    if (
      digestValue(record.ref) !== digestValue(this.options.ref) ||
      record.ownerEpoch !== this.options.ownerEpoch
    )
      throw new DomainError(
        "owner_unconfirmed",
        "Workspace operation belongs to another assignment or owner",
      );
    if (record.setup) {
      const bytes = await this.options.artifacts.read(record.setup);
      if (bytes.length !== record.setup.size || digestBytes(bytes) !== record.setup.digest)
        throw new DomainError("owner_unconfirmed", "Setup intent artifact changed");
    }
    for (const reference of record.included
      ? [record.included.intent, ...record.included.observations]
      : []) {
      const bytes = await this.options.artifacts.read(reference);
      if (bytes.length !== reference.size || digestBytes(bytes) !== reference.digest)
        throw new DomainError("owner_unconfirmed", "Included-file evidence changed");
    }
    for (const scope of record.scopes) {
      if (dirname(scope.directory) !== this.options.helperRoot)
        throw new DomainError(
          "owner_unconfirmed",
          "Workspace helper lies outside its retained helper root",
        );
      if (scope.cleanup && scope.cleanup.ownerEpoch !== record.ownerEpoch)
        throw new DomainError(
          "owner_unconfirmed",
          "Workspace helper cleanup belongs to another owner",
        );
      if (scope.cleanup)
        for (const ref of scope.cleanup.evidence) {
          const artifact = await this.options.artifacts.read(ref);
          if (artifact.length !== ref.size || digestBytes(artifact) !== ref.digest)
            throw new DomainError("owner_unconfirmed", "Workspace helper cleanup evidence changed");
        }
    }
    return record;
  }

  private async required(): Promise<WorkspaceOperation> {
    const record = await this.read();
    if (!record)
      throw new DomainError("owner_unconfirmed", "Workspace operation intent is missing");
    return record;
  }

  private async save(record: WorkspaceOperation, phase: string): Promise<ArtifactRef> {
    const previous = await this.required();
    if (record.revision !== previous.revision)
      throw new DomainError("conflict", "Workspace operation changed before publication");
    const updated = operationSchema.parse({
      ...record,
      revision: previous.revision + 1,
      previousDigest: digestValue(previous),
    });
    const bytes = Buffer.from(canonicalJson(updated));
    const artifact = await this.options.artifacts.put(bytes);
    await publishImmutable(
      join(
        this.directory(),
        `${String(updated.revision).padStart(16, "0")}-${artifact.digest}.json`,
      ),
      bytes,
      `workspace.operation.${phase}`,
      this.options.fault,
    );
    return artifact;
  }

  async initialize(plan: ArtifactRef): Promise<ArtifactRef> {
    if (await this.read())
      throw new DomainError(
        "context_unavailable",
        "Workspace preparation already has retained intent; recover it before another attempt",
      );
    const record: WorkspaceOperation = {
      schemaVersion: 1,
      revision: 0,
      previousDigest: "",
      ref: this.options.ref,
      ownerEpoch: this.options.ownerEpoch,
      plan,
      scopes: [],
      leases: [],
      inputs: [],
    };
    const bytes = Buffer.from(canonicalJson(record));
    const artifact = await this.options.artifacts.put(bytes);
    await publishImmutable(
      join(this.directory(), `${"0".repeat(16)}-${artifact.digest}.json`),
      bytes,
      "workspace.operation.initialize",
      this.options.fault,
    );
    return artifact;
  }

  async retainHelper(phase: string, git: GitCommands): Promise<void> {
    const record = await this.required();
    if (git.ownerEpoch !== record.ownerEpoch || dirname(git.directory) !== this.options.helperRoot)
      throw new DomainError("owner_unconfirmed", "Workspace helper does not match its operation");
    if (record.scopes.some((scope) => scope.cleanup?.status !== "stopped"))
      throw new DomainError(
        "owner_unconfirmed",
        "Prior workspace helper cleanup requires recovery",
      );
    await this.save(
      { ...record, scopes: [...record.scopes, { phase, directory: git.directory }] },
      "helper-intent",
    );
  }

  async closeHelper(git: GitCommands): Promise<CleanupReceipt> {
    const cleanup = await git.close();
    const record = await this.required();
    if (!record.scopes.some((scope) => scope.directory === git.directory))
      throw new DomainError("owner_unconfirmed", "Workspace helper has no retained launch intent");
    await this.save(
      {
        ...record,
        scopes: record.scopes.map((scope) =>
          scope.directory === git.directory ? { ...scope, cleanup } : scope,
        ),
      },
      "helper-cleanup",
    );
    return cleanup;
  }

  async intendLease(workspace: string): Promise<string> {
    const record = await this.required();
    const id = randomUUID();
    await this.save({ ...record, leases: [...record.leases, { id, workspace }] }, "lease-intent");
    return id;
  }

  async intendSetup(reference: ArtifactRef): Promise<void> {
    const record = await this.required();
    if (record.setup) {
      if (digestValue(record.setup) !== digestValue(reference))
        throw new DomainError("conflict", "Setup intent already differs");
      return;
    }
    await this.save({ ...record, setup: reference }, "setup-intent");
  }

  async intendInput(id: string): Promise<void> {
    const record = await this.required();
    if (record.inputs.includes(id)) return;
    await this.save({ ...record, inputs: [...record.inputs, id] }, "input-intent");
  }

  async intendIncluded(intent: ArtifactRef): Promise<void> {
    const record = await this.required();
    if (record.included)
      throw new DomainError(
        "conflict",
        "Included files already have a retained preparation intent",
      );
    await this.save({ ...record, included: { intent, observations: [] } }, "include-intent");
  }

  async observeIncluded(observation: ArtifactRef): Promise<void> {
    const record = await this.required();
    if (!record.included)
      throw new DomainError("conflict", "Included-file observation lacks its retained intent");
    await this.save(
      {
        ...record,
        included: {
          ...record.included,
          observations: [...record.included.observations, observation],
        },
      },
      "include-observation",
    );
  }

  async recoverHelpers(): Promise<CleanupReceipt> {
    let record = await this.required();
    for (let index = 0; index < record.scopes.length; index++) {
      const scope = record.scopes[index];
      if (scope.cleanup?.status === "stopped") continue;
      const cleanup = await recoverGitCleanup(
        scope.directory,
        record.ownerEpoch,
        this.options.artifacts,
      );
      record = {
        ...record,
        scopes: record.scopes.map((entry, position) =>
          position === index ? { ...entry, cleanup } : entry,
        ),
      };
      await this.save(record, "helper-recovery");
      record = await this.required();
    }
    const receipts = record.scopes.flatMap((scope) => (scope.cleanup ? [scope.cleanup] : []));
    const evidence = [
      await this.options.artifacts.put(Buffer.from(canonicalJson(record))),
      ...receipts.flatMap((receipt) => receipt.evidence),
    ];
    const identities = receipts.flatMap((receipt) => receipt.identities);
    const reasons = receipts.flatMap((receipt) =>
      receipt.status === "unconfirmed" ? receipt.reasons : [],
    );
    return reasons.length
      ? { status: "unconfirmed", ownerEpoch: record.ownerEpoch, identities, evidence, reasons }
      : { status: "stopped", ownerEpoch: record.ownerEpoch, identities, evidence };
  }
}
