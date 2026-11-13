import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactPort, CleanupReceipt } from "../contracts/backend.ts";
import { DomainError, type ArtifactRef, type AssignmentRef } from "../contracts/common.ts";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import {
  workspaceManifestSchema,
  workspaceSnapshotSchema,
  type RepositoryObservation,
  type WorkspaceEntry,
  type WorkspaceManifest,
  type WorkspaceSnapshot,
  type Worktree,
} from "../contracts/workspace.ts";
import {
  isMissing,
  replaceProjection,
  syncDirectory,
  writeSynced,
  type FaultHook,
} from "../storage/io.ts";
import {
  openCheckoutGate,
  exclusiveLeaseSchema,
  type CheckoutGate,
  type ExclusiveLease,
} from "../workspace/gate.ts";
import { ApplicationHelpers, type ApplicationHelperOptions } from "./helpers.ts";
import { repository } from "../workspace/location.ts";
import { manifestAtTree } from "../workspace/tree.ts";
import { selectWorktree } from "./worktree.ts";
import {
  applicationJournalSchema,
  type ApplicationChange,
  type ApplicationCursor,
  type ApplicationJournal,
  type ApplicationOperation,
  type ApplicationReceipt,
} from "../contracts/application.ts";
import {
  readApplicationFile,
  sameFile,
  validateApplicationPath,
  verifiedArtifact,
  writeApplicationFile,
} from "./files.ts";

export * from "../contracts/application.ts";

export type ApplicationOptions = {
  destination: string;
  artifacts: ArtifactPort;
  fault?: FaultHook;
  createGit?: ApplicationHelperOptions["createGit"];
  recoverGit?: ApplicationHelperOptions["recoverGit"];
};

const operations = new Map<string, Promise<void>>();
function serialize<T>(destination: string, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(destination) ?? Promise.resolve();
  const pending = previous.then(operation);
  const completion = pending.then(
    () => undefined,
    () => undefined,
  );
  operations.set(destination, completion);
  void completion.then(() => {
    if (operations.get(destination) === completion) operations.delete(destination);
  });
  return pending;
}
const sameArtifact = (left: ArtifactRef, right: ArtifactRef): boolean =>
  left.digest === right.digest && left.size === right.size;
const cursorKey = (snapshot: WorkspaceSnapshot): string =>
  JSON.stringify([snapshot.ref.run, snapshot.ref.worker]);

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new DomainError("conflict", "Application metadata must be a real directory");
}

export class ApplicationStore {
  readonly destination: string;
  readonly directory: string;
  private readonly artifacts: ArtifactPort;
  private readonly fault?: FaultHook;
  private readonly gate: CheckoutGate;
  private readonly helpers: ApplicationHelpers;
  private lease?: ExclusiveLease;
  private readonly ownerEpoch = randomUUID();

  private constructor(options: ApplicationOptions, gate: CheckoutGate, directory: string) {
    this.destination = gate.checkout.root;
    this.directory = directory;
    this.gate = gate;
    this.artifacts = options.artifacts;
    this.fault = options.fault;
    this.helpers = new ApplicationHelpers({
      directory,
      artifacts: options.artifacts,
      ownerEpoch: this.ownerEpoch,
      fault: options.fault,
      createGit: options.createGit,
      recoverGit: options.recoverGit,
    });
  }

  static async open(options: ApplicationOptions): Promise<ApplicationStore> {
    const gate = await openCheckoutGate(options.destination);
    const directory = join(gate.checkout.root, ".pinata", "applications");
    await ensureDirectory(directory);
    return new ApplicationStore(options, gate, await realpath(directory));
  }

  async close(): Promise<CleanupReceipt> {
    return serialize(this.destination, () => this.helpers.close());
  }

  private async release(lease: ExclusiveLease): Promise<void> {
    await this.helpers.assertStopped(lease);
    await this.gate.releaseExclusive(lease.id);
  }

  async inspect(): Promise<ApplicationJournal> {
    return structuredClone(await this.readJournal());
  }

  private async readJournal(): Promise<ApplicationJournal> {
    let bytes: Buffer;
    const path = join(this.directory, "journal.json");
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new DomainError("conflict", "Application journal must be a regular file");
      bytes = await readFile(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return {
        schemaVersion: 1,
        kind: "pinata-application-journal",
        destination: this.destination,
        revision: 0,
        cursors: {},
        operations: [],
      };
    }
    const input: unknown = JSON.parse(bytes.toString("utf8"));
    const parsed = applicationJournalSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(
        "context_unavailable",
        "Application journal lacks authoritative phase and cursor evidence; explicit reconstruction is required",
      );
    const journal = parsed.data;
    if (journal.destination !== this.destination)
      throw new DomainError("conflict", "Application journal belongs to another destination");
    let cursors: ApplicationJournal["cursors"] = {};
    const ids = new Set<string>();
    for (const [index, operation] of journal.operations.entries()) {
      const lease = exclusiveLeaseSchema.parse(operation.lease);
      if (
        ids.has(operation.id) ||
        operation.destination !== this.destination ||
        operation.repository.root !== this.destination ||
        lease.operationId !== operation.id ||
        lease.checkout.root !== this.destination ||
        digestValue(operation.beforeCursors) !== digestValue(cursors) ||
        (operation.phase === "pending" && index !== journal.operations.length - 1) ||
        (operation.phase === "applied" && operation.direction !== "apply") ||
        (operation.phase === "rolled_back" && operation.direction !== "rollback")
      )
        throw new DomainError("conflict", "Application journal contains inconsistent authority");
      ids.add(operation.id);
      if (operation.direction === "apply" && operation.worktree) {
        const selected = Object.entries(operation.afterCursors).filter(
          ([, cursor]) => cursor.operationId === operation.id,
        );
        const [key, cursor] = selected[0] ?? [];
        if (
          selected.length !== 1 ||
          !cursor ||
          key !== JSON.stringify([cursor.ref.run, cursor.ref.worker]) ||
          cursor.destination !== this.destination ||
          cursor.tree !== operation.tree ||
          digestValue(cursor.worktree ?? null) !== digestValue(operation.worktree) ||
          digestValue(operation.afterCursors) !==
            digestValue({ ...operation.beforeCursors, [key]: cursor })
        )
          throw new DomainError(
            "conflict",
            "Worktree application cursor disagrees with its selected tree",
          );
      }
      const paths = new Set<string>();
      for (const change of operation.changes) {
        validateApplicationPath(change.path);
        const normalized = process.platform === "linux" ? change.path : change.path.toLowerCase();
        if (paths.has(normalized))
          throw new DomainError("conflict", "Application journal repeats a destination path");
        paths.add(normalized);
        for (const state of [change.before, change.after])
          if (state) await verifiedArtifact(this.artifacts, state.blob);
      }
      if (operation.direction === "rollback") {
        const original = journal.operations.find(
          (candidate) => candidate.id === operation.rollbackOf,
        );
        if (
          !original ||
          original.direction !== "apply" ||
          original.phase !== "applied" ||
          digestValue(original.snapshot ?? null) !== digestValue(operation.snapshot ?? null) ||
          digestValue(original.worktree ?? null) !== digestValue(operation.worktree ?? null) ||
          original.tree !== operation.tree ||
          digestValue(
            original.changes.map((change) => ({
              path: change.path,
              before: change.after,
              after: change.before,
            })),
          ) !== digestValue(operation.changes) ||
          digestValue(original.beforeCursors) !== digestValue(operation.afterCursors)
        )
          throw new DomainError(
            "conflict",
            "Rollback journal does not preserve its original application",
          );
      }
      if (operation.phase !== "pending") cursors = operation.afterCursors;
    }
    if (digestValue(cursors) !== digestValue(journal.cursors))
      throw new DomainError(
        "conflict",
        "Application cursors disagree with the authoritative terminal journal",
      );
    for (const [key, cursor] of Object.entries(journal.cursors)) {
      if (
        cursor.destination !== this.destination ||
        key !== JSON.stringify([cursor.ref.run, cursor.ref.worker]) ||
        !ids.has(cursor.operationId)
      )
        throw new DomainError("conflict", "Application cursor identity is invalid");
    }
    return journal;
  }

  private async publishJournal(
    journal: ApplicationJournal,
    phase: "intent" | "recovery" | "terminal",
  ): Promise<void> {
    const bytes = Buffer.from(canonicalJson(applicationJournalSchema.parse(journal)));
    const staged = join(this.directory, `.journal-${randomUUID()}`);
    const label = `application.journal.${phase}`;
    await writeSynced(staged, bytes, label, this.fault);
    await this.fault?.(`${label}.rename.before`);
    await rename(staged, join(this.directory, "journal.json"));
    await this.fault?.(`${label}.rename.after`);
    await this.fault?.(`${label}.directory-sync.before`);
    await syncDirectory(this.directory);
    await this.fault?.(`${label}.directory-sync.after`);
  }

  private async projection(journal: ApplicationJournal): Promise<void> {
    await replaceProjection(
      join(this.directory, "snapshots.json"),
      Buffer.from(canonicalJson({ revision: journal.revision, cursors: journal.cursors })),
      "application.projection",
      this.fault,
    );
  }

  private async manifest(ref: ArtifactRef): Promise<WorkspaceManifest> {
    const manifest = workspaceManifestSchema.parse(
      JSON.parse(Buffer.from(await verifiedArtifact(this.artifacts, ref)).toString("utf8")),
    );
    if (manifest.observation.status !== "stable")
      throw new DomainError("conflict", "Application requires a stable saved workspace snapshot");
    const paths = new Set<string>();
    for (const entry of manifest.entries) {
      // Unchanged symlinks, submodules and secret files can exist in a checkout;
      // only the selected delta receives application path and mode restrictions.
      if (
        !entry.path ||
        entry.path.startsWith("/") ||
        entry.path.includes("\\") ||
        entry.path.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new DomainError("invalid_input", "Snapshot contains an unsafe manifest path");
      const normalized = process.platform === "linux" ? entry.path : entry.path.toLowerCase();
      if (paths.has(normalized))
        throw new DomainError("conflict", "Snapshot contains duplicate or aliased paths");
      paths.add(normalized);
      if (entry.mode !== "160000") await verifiedArtifact(this.artifacts, entry.blob);
    }
    return manifest;
  }

  private async validateTree(
    tree: string,
    manifest: WorkspaceManifest,
    repo: RepositoryObservation,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await (
      await this.helpers.git()
    ).run(this.destination, ["ls-tree", "-rz", "--full-tree", tree], {
      signal,
    });
    if (!Buffer.from(result.stdout.toString("utf8")).equals(result.stdout))
      throw new DomainError("invalid_input", "Snapshot tree contains a non-UTF-8 path");
    const actual = result.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const match = /^(100644|100755|120000|160000) (?:blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(
          line,
        );
        if (!match)
          throw new DomainError("conflict", "Snapshot tree contains an unsupported Git entry");
        return { mode: match[1], objectId: match[2], path: match[3] };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    const expected = [];
    for (const entry of manifest.entries) {
      const bytes =
        entry.mode === "160000" ? undefined : await verifiedArtifact(this.artifacts, entry.blob);
      const objectId = bytes
        ? createHash(repo.objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
        : entry.objectId;
      if (entry.objectId && entry.objectId !== objectId)
        throw new DomainError(
          "conflict",
          `Snapshot blob object disagrees with retained content: ${entry.path}`,
        );
      expected.push({ mode: entry.mode, objectId, path: entry.path });
    }
    expected.sort((left, right) => left.path.localeCompare(right.path));
    if (digestValue(expected) !== digestValue(actual))
      throw new DomainError("conflict", "Snapshot Git tree does not match its immutable manifest");
  }

  private async snapshot(
    ref: ArtifactRef,
    signal?: AbortSignal,
    composition = false,
  ): Promise<{
    snapshot: WorkspaceSnapshot;
    base: WorkspaceManifest;
    current: WorkspaceManifest;
    destinationRepository: RepositoryObservation;
  }> {
    const snapshot = workspaceSnapshotSchema.parse(
      JSON.parse(Buffer.from(await verifiedArtifact(this.artifacts, ref)).toString("utf8")),
    );
    if (snapshot.mode !== "worktree" || !snapshot.baseTree || !snapshot.tree)
      throw new DomainError(
        "unsupported",
        "Application requires an isolated snapshot with retained base and result Git trees",
      );
    const base = await this.manifest(snapshot.base);
    const current = await this.manifest(snapshot.manifest);
    const repo = base.repository;
    if (!repo) throw new DomainError("conflict", "Snapshot base lacks its source Git repository");
    let destinationRepository = repo;
    if (composition) {
      const destination = await repository(this.destination, await this.helpers.git(), signal);
      if (
        !destination ||
        destination.commonDirectory !== repo.commonDirectory ||
        destination.objectFormat !== repo.objectFormat
      )
        throw new DomainError(
          "conflict",
          "Explicit snapshot inputs require a worktree in the same Git repository",
        );
      destinationRepository = destination;
    } else if (repo.root !== this.destination)
      throw new DomainError("conflict", "Snapshot base was frozen for another destination");
    await this.assertRepository(destinationRepository, signal);
    await this.validateTree(snapshot.baseTree, base, repo, signal);
    await this.validateTree(snapshot.tree, current, repo, signal);
    return { snapshot, base, current, destinationRepository };
  }

  private async assertRepository(
    expected: RepositoryObservation,
    signal?: AbortSignal,
  ): Promise<void> {
    const held = (await this.gate.inspect()).exclusive;
    if (!held || !this.lease || digestValue(held) !== digestValue(this.lease))
      throw new DomainError(
        "owner_unconfirmed",
        "Application no longer holds its exact checkout lease",
      );
    const current = await repository(this.destination, await this.helpers.git(), signal);
    if (!current || digestValue(current) !== digestValue(expected))
      throw new DomainError(
        "conflict",
        "Destination repository, HEAD, branch or index changed; reconcile it before application",
      );
  }

  private changes(before: WorkspaceManifest, after: WorkspaceManifest): ApplicationChange[] {
    const previous = new Map(before.entries.map((entry) => [entry.path, entry]));
    const current = new Map(after.entries.map((entry) => [entry.path, entry]));
    const paths = [...new Set([...previous.keys(), ...current.keys()])].sort();
    const changes: ApplicationChange[] = [];
    const file = (entry?: WorkspaceEntry) => {
      if (!entry) return null;
      if (entry.mode === "120000" || entry.mode === "160000")
        throw new DomainError(
          "capability_denied",
          `Application refuses symlink or submodule changes: ${entry.path}`,
        );
      return { mode: entry.mode, blob: entry.blob };
    };
    for (const path of paths) {
      const left = previous.get(path);
      const right = current.get(path);
      if (
        left &&
        right &&
        left.mode === right.mode &&
        (left.mode === "160000" && right.mode === "160000"
          ? left.objectId === right.objectId
          : left.mode !== "160000" &&
            right.mode !== "160000" &&
            sameArtifact(left.blob, right.blob))
      )
        continue;
      const oldFile = file(left);
      const newFile = file(right);
      if (sameFile(oldFile, newFile)) continue;
      validateApplicationPath(path);
      changes.push({ path, before: oldFile, after: newFile });
    }
    return changes;
  }

  async applyWorktree(request: {
    ref: AssignmentRef;
    worktree: Worktree;
    operationId?: string;
    signal?: AbortSignal;
  }): Promise<ApplicationReceipt> {
    return serialize(this.destination, async () => {
      const id = request.operationId ?? randomUUID();
      const lease = await this.gate.acquireExclusive(
        { operationId: id, ownerEpoch: this.ownerEpoch, purpose: "apply" },
        request.signal,
      );
      this.lease = lease;
      this.helpers.attach(lease);
      let intent = false;
      try {
        const journal = await this.readJournal();
        if (journal.operations.at(-1)?.phase === "pending")
          throw new DomainError(
            "conflict",
            "Reconcile the pending application before starting another operation",
          );
        const key = JSON.stringify([request.ref.run, request.ref.worker]);
        const recorded = journal.operations.find((operation) => operation.id === id);
        if (recorded) {
          if (
            recorded.direction !== "apply" ||
            digestValue(recorded.worktree ?? null) !== digestValue(request.worktree) ||
            digestValue(recorded.afterCursors[key]?.ref ?? null) !== digestValue(request.ref)
          )
            throw new DomainError("conflict", "Application identity names another operation");
          return await this.receipt(journal, recorded, "already_recorded");
        }
        const git = await this.helpers.git();
        const selected = await selectWorktree({
          ...request,
          destination: this.destination,
          artifacts: this.artifacts,
          git,
        });
        await this.fault?.("application.validation.after");
        const cursor = Object.hasOwn(journal.cursors, key) ? journal.cursors[key] : undefined;
        if (cursor?.worktree && digestValue(cursor.worktree) !== digestValue(request.worktree))
          throw new DomainError("conflict", "Previously applied worktree identity changed");
        const before = await manifestAtTree(
          this.destination,
          cursor?.tree ?? selected.baseTree,
          git,
          this.artifacts,
          request.signal,
        );
        const changes = this.changes(before, selected.current);
        for (const change of changes)
          if (!sameFile(await readApplicationFile(this.destination, change.path), change.before))
            throw new DomainError(
              "conflict",
              `Destination has conflicting changes: ${change.path}`,
            );
        await this.assertRepository(selected.repository, request.signal);
        // Git retains the selected tree for subsequent applications. Before/after
        // file blobs in the journal remain sufficient for interrupted writes.
        await git.run(
          this.destination,
          ["update-ref", `refs/pinata/applications/${digestValue(id)}`, selected.tree],
          { signal: request.signal },
        );
        const next: ApplicationCursor = {
          destination: this.destination,
          ref: request.ref,
          worktree: request.worktree,
          tree: selected.tree,
          operationId: id,
        };
        const operation: ApplicationOperation = {
          id,
          direction: "apply",
          mode: "delivery",
          phase: "pending",
          destination: this.destination,
          repository: selected.repository,
          worktree: request.worktree,
          tree: selected.tree,
          changes,
          beforeCursors: journal.cursors,
          afterCursors: { ...journal.cursors, [key]: next },
          lease,
        };
        const pending = {
          ...journal,
          revision: journal.revision + 1,
          operations: [...journal.operations, operation],
        };
        intent = true;
        await this.publishJournal(pending, "intent");
        return await this.finish(pending, operation, lease, request.signal);
      } finally {
        if (!intent) await this.release(lease);
      }
    });
  }

  async apply(request: {
    snapshot: ArtifactRef;
    operationId?: string;
    signal?: AbortSignal;
  }): Promise<ApplicationReceipt> {
    return this.applySnapshot(request, false);
  }

  async applyInput(request: {
    snapshot: ArtifactRef;
    operationId?: string;
    signal?: AbortSignal;
  }): Promise<ApplicationReceipt> {
    return this.applySnapshot(request, true);
  }

  private async applySnapshot(
    request: { snapshot: ArtifactRef; operationId?: string; signal?: AbortSignal },
    composition: boolean,
  ): Promise<ApplicationReceipt> {
    return serialize(this.destination, async () => {
      const id = request.operationId ?? randomUUID();
      const lease = await this.gate.acquireExclusive(
        { operationId: id, ownerEpoch: this.ownerEpoch, purpose: "apply" },
        request.signal,
      );
      this.lease = lease;
      this.helpers.attach(lease);
      let intent = false;
      try {
        const journal = await this.readJournal();
        if (journal.operations.at(-1)?.phase === "pending")
          throw new DomainError(
            "conflict",
            "Reconcile the pending application before starting another operation",
          );
        const loaded = await this.snapshot(request.snapshot, request.signal, composition);
        await this.fault?.("application.validation.after");
        const key = cursorKey(loaded.snapshot);
        const cursor = Object.hasOwn(journal.cursors, key) ? journal.cursors[key] : undefined;
        if (cursor?.snapshot && sameArtifact(cursor.snapshot, request.snapshot)) {
          const original = journal.operations.find(
            (operation) => operation.id === cursor.operationId,
          );
          if (!original)
            throw new DomainError("conflict", "Applied snapshot lacks its original operation");
          await this.projection(journal);
          return await this.receipt(journal, original, "already_recorded");
        }
        if (journal.operations.some((operation) => operation.id === id))
          throw new DomainError("conflict", "Application operation identity is already recorded");
        let before = loaded.base;
        if (cursor) {
          if (!cursor.snapshot || !cursor.manifest)
            throw new DomainError(
              "conflict",
              "Worktree application has advanced beyond legacy assignment snapshots",
            );
          if (cursor.ref.assignment >= loaded.snapshot.ref.assignment)
            throw new DomainError(
              "conflict",
              "Application snapshot does not advance the worker assignment cursor",
            );
          const saved = await this.snapshot(cursor.snapshot, request.signal, composition);
          if (
            !sameArtifact(saved.snapshot.manifest, cursor.manifest) ||
            saved.snapshot.tree !== cursor.tree ||
            digestValue(saved.snapshot.ref) !== digestValue(cursor.ref)
          )
            throw new DomainError(
              "conflict",
              "Applied snapshot cursor does not match its retained snapshot",
            );
          before = saved.current;
        }
        const changes = this.changes(before, loaded.current);
        for (const change of changes)
          if (!sameFile(await readApplicationFile(this.destination, change.path), change.before))
            throw new DomainError(
              "conflict",
              `Destination has conflicting changes: ${change.path}`,
            );
        const repo = loaded.destinationRepository;
        const tree = loaded.snapshot.tree;
        if (!repo || !tree) throw new Error("Validated isolated snapshot lacks Git identity");
        const next: ApplicationCursor = {
          destination: this.destination,
          ref: loaded.snapshot.ref,
          snapshot: request.snapshot,
          manifest: loaded.snapshot.manifest,
          tree,
          operationId: id,
        };
        const operation: ApplicationOperation = {
          id,
          direction: "apply",
          mode: composition ? "input" : "delivery",
          phase: "pending",
          destination: this.destination,
          repository: repo,
          snapshot: request.snapshot,
          changes,
          beforeCursors: journal.cursors,
          afterCursors: { ...journal.cursors, [key]: next },
          lease,
        };
        const pending = {
          ...journal,
          revision: journal.revision + 1,
          operations: [...journal.operations, operation],
        };
        intent = true;
        await this.publishJournal(pending, "intent");
        return await this.finish(pending, operation, lease, request.signal);
      } finally {
        if (!intent) await this.release(lease);
      }
    });
  }

  async rollback(
    operationId: string,
    signal?: AbortSignal,
    options: { id?: string } = {},
  ): Promise<ApplicationReceipt> {
    return serialize(this.destination, async () => {
      const id = options.id ?? randomUUID();
      const lease = await this.gate.acquireExclusive(
        { operationId: id, ownerEpoch: this.ownerEpoch, purpose: "rollback" },
        signal,
      );
      this.lease = lease;
      this.helpers.attach(lease);
      let intent = false;
      try {
        const journal = await this.readJournal();
        const original = journal.operations.at(-1);
        if (!original || original.id !== operationId || original.phase !== "applied")
          throw new DomainError(
            "conflict",
            "Rollback requires the latest completed application; reconcile pending or later operations first",
          );
        await this.assertRepository(original.repository, signal);
        const changes = original.changes.map((change) => ({
          path: change.path,
          before: change.after,
          after: change.before,
        }));
        for (const change of changes)
          if (!sameFile(await readApplicationFile(this.destination, change.path), change.before))
            throw new DomainError("conflict", `Rollback refuses later edits: ${change.path}`);
        const operation: ApplicationOperation = {
          id,
          direction: "rollback",
          mode: original.mode,
          phase: "pending",
          rollbackOf: original.id,
          destination: this.destination,
          repository: original.repository,
          ...(original.snapshot
            ? { snapshot: original.snapshot }
            : { worktree: original.worktree, tree: original.tree }),
          changes,
          beforeCursors: journal.cursors,
          afterCursors: original.beforeCursors,
          lease,
        };
        const pending = {
          ...journal,
          revision: journal.revision + 1,
          operations: [...journal.operations, operation],
        };
        intent = true;
        await this.publishJournal(pending, "intent");
        return await this.finish(pending, operation, lease, signal);
      } finally {
        if (!intent) await this.release(lease);
      }
    });
  }

  async reconcile(signal?: AbortSignal): Promise<ApplicationReceipt | null> {
    return serialize(this.destination, async () => {
      const retained = (await this.gate.inspect()).exclusive;
      if (!retained) {
        const lease = await this.gate.acquireExclusive(
          { operationId: randomUUID(), ownerEpoch: this.ownerEpoch, purpose: "recovery" },
          signal,
        );
        this.lease = lease;
        this.helpers.attach(lease);
        try {
          const journal = await this.readJournal();
          const operation = journal.operations.at(-1);
          if (operation?.phase === "pending")
            throw new DomainError(
              "owner_unconfirmed",
              "Pending application lost its checkout exclusion; inspect its journal before reconstruction",
            );
          await this.projection(journal);
          return operation ? await this.receipt(journal, operation, "already_recorded") : null;
        } finally {
          await this.release(lease);
        }
      }
      const lease = await this.gate.recoverExclusive(retained);
      this.lease = lease;
      await this.helpers.recover(lease);
      // Reread only after recovery owns exclusion. A stale pre-lease read can
      // mistake another process's committed intent for an unpublished operation.
      let journal = await this.readJournal();
      let operation = journal.operations.at(-1);
      if (!operation || lease.operationId !== operation.id) {
        if (journal.operations.some((entry) => entry.id === lease.operationId))
          throw new DomainError(
            "conflict",
            "Retained application lease belongs to an earlier operation",
          );
        await this.release(lease);
        await this.projection(journal);
        return null;
      }
      const recordedLease = exclusiveLeaseSchema.parse(operation.lease);
      if (
        recordedLease.id !== lease.id ||
        recordedLease.ownerEpoch !== lease.ownerEpoch ||
        digestValue(recordedLease.checkout) !== digestValue(lease.checkout)
      )
        throw new DomainError(
          "owner_unconfirmed",
          "Application lease no longer matches its retained operation",
        );
      operation = { ...operation, lease };
      journal = {
        ...journal,
        revision: journal.revision + 1,
        operations: [...journal.operations.slice(0, -1), operation],
      };
      await this.publishJournal(journal, "recovery");
      if (operation.phase !== "pending") {
        await this.assertRepository(operation.repository, signal);
        for (const change of operation.changes)
          if (!sameFile(await readApplicationFile(this.destination, change.path), change.after))
            throw new DomainError(
              "conflict",
              `Terminal application no longer matches destination bytes: ${change.path}`,
            );
        await this.projection(journal);
        const receipt: ApplicationReceipt = {
          status: "already_recorded",
          operationId: operation.id,
          destination: this.destination,
          revision: journal.revision,
          ...(operation.snapshot
            ? { snapshot: operation.snapshot }
            : { worktree: operation.worktree, tree: operation.tree }),
          freshness: "matching",
        };
        await this.release(lease);
        return receipt;
      }
      return this.finish(journal, operation, lease, signal);
    });
  }

  private async finish(
    journal: ApplicationJournal,
    operation: ApplicationOperation,
    lease: ExclusiveLease,
    signal?: AbortSignal,
  ): Promise<ApplicationReceipt> {
    await this.assertRepository(operation.repository, signal);
    // Check every affected path before resuming any writes, so a conflict on a
    // later path cannot overwrite earlier paths during the same recovery attempt.
    for (const change of operation.changes) {
      const current = await readApplicationFile(this.destination, change.path);
      if (!sameFile(current, change.before) && !sameFile(current, change.after))
        throw new DomainError(
          "conflict",
          `Application recovery refuses later edits: ${change.path}`,
        );
    }
    for (const change of operation.changes)
      await writeApplicationFile({
        root: this.destination,
        change,
        operationId: operation.id,
        artifacts: this.artifacts,
        assertRepository: () => this.assertRepository(operation.repository, signal),
        fault: this.fault,
        signal,
      });
    await this.assertRepository(operation.repository, signal);
    for (const change of operation.changes)
      if (!sameFile(await readApplicationFile(this.destination, change.path), change.after))
        throw new DomainError(
          "conflict",
          `Application destination changed before commit: ${change.path}`,
        );
    const terminal: ApplicationOperation = {
      ...operation,
      phase: operation.direction === "apply" ? "applied" : "rolled_back",
    };
    const committed: ApplicationJournal = {
      ...journal,
      revision: journal.revision + 1,
      cursors: operation.afterCursors,
      operations: [...journal.operations.slice(0, -1), terminal],
    };
    await this.helpers.assertStopped(lease);
    await this.publishJournal(committed, "terminal");
    await this.projection(committed);
    const receipt: ApplicationReceipt = {
      status: terminal.phase === "applied" ? "applied" : "rolled_back",
      operationId: operation.id,
      destination: this.destination,
      revision: committed.revision,
      ...(operation.snapshot
        ? { snapshot: operation.snapshot }
        : { worktree: operation.worktree, tree: operation.tree }),
      freshness: "matching",
    };
    await this.release(lease);
    return receipt;
  }

  private async receipt(
    journal: ApplicationJournal,
    operation: ApplicationOperation,
    status: ApplicationReceipt["status"],
  ): Promise<ApplicationReceipt> {
    let freshness: ApplicationReceipt["freshness"] = "matching";
    try {
      await this.assertRepository(operation.repository);
      for (const change of operation.changes)
        if (!sameFile(await readApplicationFile(this.destination, change.path), change.after))
          freshness = "changed";
    } catch {
      freshness = "unknown";
    }
    return {
      status,
      operationId: operation.id,
      destination: this.destination,
      revision: journal.revision,
      ...(operation.snapshot
        ? { snapshot: operation.snapshot }
        : { worktree: operation.worktree, tree: operation.tree }),
      freshness,
    };
  }
}
