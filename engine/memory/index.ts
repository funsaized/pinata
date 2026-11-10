import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { frozenWorkerSchema, type FrozenWorker } from "../contracts/commands.ts";
import { DomainError, type ArtifactRef } from "../contracts/common.ts";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import {
  memoryClearSchema,
  memoryEditSchema,
  memoryHeadSchema,
  memoryRevisionSchema,
  type MemoryRevision,
  type MemoryScope,
  type MemorySnapshot,
} from "../contracts/memory.ts";
import type { Owner } from "../contracts/storage.ts";
import { assertOwnerDead, claimOwner, readOwner, releaseOwner } from "../storage/owner.ts";
import {
  digestBytes,
  isExisting,
  isMissing,
  publishImmutable,
  replaceProjection,
  StorageError,
  syncDirectory,
  type FaultHook,
} from "../storage/io.ts";

export type MemoryOptions = {
  project: string;
  run: string;
  worker: FrozenWorker;
  fault?: FaultHook;
};

async function directory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isExisting(error)) throw error;
  }
  const state = await lstat(path);
  if (!state.isDirectory() || state.isSymbolicLink())
    throw new DomainError("capability_denied", "Memory directories cannot traverse links");
}
async function regularFile(path: string): Promise<Buffer | undefined> {
  try {
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink())
      throw new DomainError(
        "capability_denied",
        "Memory records must be regular files without links",
      );
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

// This host-created binding supplies namespace and grants. Model-facing operations
// carry only text/data and a CAS revision, never a path, project or capability.
export class MemoryStore {
  readonly scope: MemoryScope;
  readonly directory: string;
  private readonly worker: FrozenWorker;
  private readonly run: string;
  private readonly fault?: FaultHook;
  private readonly projectIdentity: { device: number; inode: number };

  private constructor(
    options: MemoryOptions,
    worker: FrozenWorker,
    scope: MemoryScope,
    path: string,
    identity: { device: number; inode: number },
  ) {
    this.scope = Object.freeze(scope);
    this.directory = path;
    this.worker = structuredClone(worker);
    this.run = options.run;
    this.fault = options.fault;
    this.projectIdentity = identity;
  }

  static async open(options: MemoryOptions): Promise<MemoryStore> {
    const worker = frozenWorkerSchema.parse(options.worker);
    if (worker.grants.memory.scope === "none")
      throw new DomainError("capability_denied", "Worker has no retained-memory grant");
    if (!options.run || options.run.includes("\0"))
      throw new DomainError("invalid_input", "Memory binding requires a run identity");
    const project = await realpath(options.project);
    const state = await lstat(project);
    if (!state.isDirectory())
      throw new DomainError("invalid_input", "Memory project is not a directory");
    const scope: MemoryScope =
      worker.grants.memory.scope === "worker"
        ? { kind: "worker", project, run: options.run, worker: worker.id }
        : { kind: "project-agent", project, agent: worker.agent };
    const path = join(project, ".pinata", "memory", scope.kind, digestValue(scope));
    const store = new MemoryStore(options, worker, scope, path, {
      device: state.dev,
      inode: state.ino,
    });
    // Reading an absent namespace never creates a memory store or takes ownership.
    await store.assertPath(false);
    return store;
  }

  private requireWrite(): void {
    if (this.worker.grants.memory.access !== "write")
      throw new DomainError(
        "capability_denied",
        "Memory writes require an explicit scoped memory write grant",
      );
  }
  private async assertPath(create: boolean): Promise<void> {
    const state = await lstat(this.scope.project);
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      state.dev !== this.projectIdentity.device ||
      state.ino !== this.projectIdentity.inode
    )
      throw new DomainError("capability_denied", "Canonical memory project identity changed");
    let path = this.scope.project;
    for (const component of [".pinata", "memory", this.scope.kind, digestValue(this.scope)]) {
      path = join(path, component);
      if (create) await directory(path);
      else {
        try {
          const entry = await lstat(path);
          if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new DomainError(
              "capability_denied",
              "Memory path traverses a link or non-directory",
            );
        } catch (error) {
          if (isMissing(error)) return;
          throw error;
        }
      }
    }
    for (const name of ["records", "owners", "evidence", "owner"]) {
      const child = join(path, name);
      if (create && name !== "owner") await directory(child);
      else {
        try {
          const entry = await lstat(child);
          if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new DomainError(
              "capability_denied",
              "Memory metadata directories cannot traverse links",
            );
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    }
  }
  private async record(ref: ArtifactRef): Promise<MemoryRevision> {
    const bytes = await regularFile(join(this.directory, "records", `${ref.digest}.json`));
    if (!bytes || bytes.length !== ref.size || digestBytes(bytes) !== ref.digest)
      throw new DomainError("context_unavailable", "Memory revision is missing or corrupted");
    const record = memoryRevisionSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (digestValue(record.scope) !== digestValue(this.scope))
      throw new DomainError("capability_denied", "Memory revision belongs to another scope");
    return record;
  }
  async read(): Promise<MemorySnapshot> {
    await this.assertPath(false);
    const bytes = await regularFile(join(this.directory, "head.json"));
    if (!bytes) return { scope: structuredClone(this.scope), revision: 0, value: null };
    const head = memoryHeadSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (digestValue(head.scope) !== digestValue(this.scope))
      throw new DomainError("capability_denied", "Memory head belongs to another scope");
    const record = await this.record(head.record);
    if (record.revision !== head.revision)
      throw new DomainError("conflict", "Memory head revision disagrees with its immutable record");
    return structuredClone({
      scope: this.scope,
      revision: record.revision,
      value: record.value,
      record: head.record,
      provenance: record.provenance,
    });
  }
  async history(): Promise<MemoryRevision[]> {
    const head = await this.read();
    const revisions: MemoryRevision[] = [];
    let ref = head.record;
    let expected = head.revision;
    const seen = new Set<string>();
    while (ref) {
      if (seen.has(ref.digest)) throw new DomainError("conflict", "Memory revision chain cycles");
      seen.add(ref.digest);
      const record = await this.record(ref);
      if (record.revision !== expected)
        throw new DomainError("conflict", "Memory revision chain is not contiguous");
      revisions.push(record);
      expected--;
      ref = record.previous;
    }
    if (expected !== 0)
      throw new DomainError("context_unavailable", "Memory revision history is incomplete");
    return structuredClone(revisions);
  }
  async edit(input: unknown): Promise<MemorySnapshot> {
    this.requireWrite();
    const request = memoryEditSchema.parse(input);
    return this.write(request.expectedRevision, {
      text: request.text,
      ...(request.data === undefined ? {} : { data: request.data }),
    });
  }
  async clear(input: unknown): Promise<MemorySnapshot> {
    this.requireWrite();
    return this.write(memoryClearSchema.parse(input).expectedRevision, null);
  }
  private async write(
    expectedRevision: number,
    value: MemoryRevision["value"],
  ): Promise<MemorySnapshot> {
    await this.assertPath(true);
    let owner: Owner;
    try {
      owner = await claimOwner(this.directory);
    } catch (error) {
      if (error instanceof StorageError)
        throw new DomainError(
          "conflict",
          "Memory is being edited or has an unreconciled owner; read the current revision and retry after reconciliation",
        );
      throw error;
    }
    try {
      await this.assertPath(false);
      const previous = await this.read();
      if (previous.revision !== expectedRevision)
        throw new DomainError(
          "conflict",
          `Memory revision changed: expected ${expectedRevision}, found ${previous.revision}`,
        );
      const record: MemoryRevision = memoryRevisionSchema.parse({
        schemaVersion: 1,
        scope: this.scope,
        revision: previous.revision + 1,
        ...(previous.record ? { previous: previous.record } : {}),
        value,
        provenance: {
          run: this.run,
          worker: this.worker.id,
          agent: this.worker.agent,
          definition: this.worker.definition,
        },
      });
      const bytes = Buffer.from(canonicalJson(record));
      const artifact = { digest: digestBytes(bytes), size: bytes.length };
      await publishImmutable(
        join(this.directory, "records", `${artifact.digest}.json`),
        bytes,
        "memory.record",
        this.fault,
      );
      try {
        await replaceProjection(
          join(this.directory, "head.json"),
          Buffer.from(
            canonicalJson({
              schemaVersion: 1,
              scope: this.scope,
              revision: record.revision,
              record: artifact,
            }),
          ),
          "memory.head",
          this.fault,
        );
      } catch (cause) {
        throw new StorageError(
          "commit_unknown",
          "Memory publication acknowledgment is uncertain; inspect its revision before retrying",
          { cause },
        );
      }
      return structuredClone({
        scope: this.scope,
        revision: record.revision,
        value,
        record: artifact,
        provenance: record.provenance,
      });
    } finally {
      await releaseOwner(this.directory, owner);
    }
  }
  async inspectOwner(): Promise<Owner | undefined> {
    await this.assertPath(false);
    return readOwner(this.directory);
  }
  async reconcileOwner(expectedToken: string, reason: string): Promise<void> {
    this.requireWrite();
    if (!reason.trim())
      throw new DomainError(
        "invalid_input",
        "Memory ownership reconciliation requires an audit reason",
      );
    await this.assertPath(false);
    const fence = join(this.directory, "reconciling");
    await mkdir(fence, { mode: 0o700 });
    let mutated = false;
    try {
      const owner = await readOwner(this.directory);
      if (!owner || owner.token !== expectedToken)
        throw new DomainError(
          "owner_unconfirmed",
          "Memory reconciliation requires its exact retained owner",
        );
      assertOwnerDead(owner);
      await this.history();
      const evidence = join(this.directory, "evidence", randomUUID());
      await directory(evidence);
      mutated = true;
      await publishImmutable(
        join(evidence, "reconciliation.json"),
        Buffer.from(canonicalJson({ schemaVersion: 1, scope: this.scope, owner, reason })),
        "memory.reconciliation",
        this.fault,
      );
      await rename(join(this.directory, "owner"), join(evidence, "owner"));
      await syncDirectory(evidence);
      await syncDirectory(this.directory);
      await rmdir(fence);
      await syncDirectory(this.directory);
    } catch (error) {
      if (!mutated) await rmdir(fence);
      throw error;
    }
  }
}
