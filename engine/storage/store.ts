import { constants, type BigIntStats } from "node:fs";
import { mkdir, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  checkpointSchema,
  coreStateSchema,
  type CoreState,
  journalFrameSchema,
  journalRecordSchema,
  manifestSchema,
  type ArtifactRef,
  type JournalFrame,
  type Manifest,
  type Transition,
} from "../contracts/index.ts";
import { initialState, reduce } from "../core/state.ts";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import {
  digestBytes,
  publishImmutable,
  readOptional,
  replaceProjection,
  StorageError,
  syncDirectory,
  type FaultHook,
} from "./io.ts";
import { inspectStore, verifyArtifact, verifyArtifactBytes } from "./journal.ts";
import { parseConversationManifest } from "./conversation.ts";
import { assertOwner, claimOwner, releaseOwner, type OwnerClaim } from "./owner.ts";

export type OpenStoreOptions = {
  directory: string;
  manifest?: unknown;
  fault?: FaultHook;
};
export type AppendRequest = {
  requestId: string;
  payloadDigest: string;
  transition: Transition;
  artifacts?: ArtifactRef[];
};
type ArtifactVersion = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;

function sameArtifactVersion(left: ArtifactVersion, right: ArtifactVersion): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export class DurableStore {
  readonly directory: string;
  readonly manifest: Manifest;
  readonly owner: OwnerClaim;
  readonly replayWarnings: readonly string[];
  private readonly projection?: CoreState;
  private committed: JournalFrame[];
  private readonly journal: FileHandle;
  private journalVersion: ArtifactVersion;
  private readonly requests: Map<string, JournalFrame>;
  private readonly artifactChildren = new Map<string, ArtifactRef[]>();
  private readonly publishedArtifacts = new Map<string, ArtifactVersion>();
  private readonly fault?: FaultHook;
  private pending: Promise<void> = Promise.resolve();
  private uncertain = false;
  private closed = false;

  private constructor(options: {
    directory: string;
    manifest: Manifest;
    owner: OwnerClaim;
    frames: JournalFrame[];
    journal: FileHandle;
    journalVersion: ArtifactVersion;
    fault?: FaultHook;
    replayWarnings: string[];
    projection?: CoreState;
  }) {
    this.directory = options.directory;
    this.manifest = Object.freeze(options.manifest);
    this.owner = Object.freeze(options.owner);
    this.committed = options.frames;
    this.journal = options.journal;
    this.journalVersion = options.journalVersion;
    this.requests = new Map(options.frames.map((frame) => [frame.record.requestId, frame]));
    this.fault = options.fault;
    this.replayWarnings = Object.freeze(options.replayWarnings);
    this.projection = options.projection;
  }

  static async open(options: OpenStoreOptions): Promise<DurableStore> {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const directory = await realpath(options.directory);
    const existing = await readOptional(join(directory, "run.json"));
    const manifest = manifestSchema.parse(
      existing ? JSON.parse(existing.toString("utf8")) : options.manifest,
    );
    if (!isAbsolute(manifest.workspace) || resolve(manifest.store) !== directory) {
      throw new StorageError(
        "conflict",
        "Manifest requires an absolute workspace and its canonical store path",
      );
    }
    if (
      existing &&
      options.manifest &&
      digestValue(manifestSchema.parse(options.manifest)) !== digestValue(manifest)
    ) {
      throw new StorageError("conflict", "Existing manifest differs from the requested run");
    }
    const owner = await claimOwner(directory, options.fault);
    // Failed publication or replay retains the claim for explicit reconciliation.
    if (!existing)
      await publishImmutable(
        join(directory, "run.json"),
        Buffer.from(canonicalJson(manifest)),
        "manifest",
        options.fault,
      );
    const inspection = await inspectStore(directory);
    if (inspection.tail.length)
      throw new StorageError(
        "commit_unknown",
        "Incomplete journal tail requires explicit isolation before reopening",
      );
    const replayWarnings: string[] = [];
    let projection: CoreState | undefined;
    const checkpointBytes = await readOptional(join(directory, "checkpoints", "latest.json"));
    if (checkpointBytes) {
      try {
        const checkpoint = checkpointSchema.parse(JSON.parse(checkpointBytes.toString("utf8")));
        const expectedDigest = checkpoint.revision
          ? inspection.frames[checkpoint.revision - 1]?.digest
          : "";
        if (checkpoint.digest !== expectedDigest)
          throw new Error("Checkpoint does not match the journal chain");
        if (checkpoint.projection === "core") {
          const saved = coreStateSchema.parse(checkpoint.snapshot);
          let expected = initialState(manifest.run);
          // A checksum binds bytes to a revision, not their meaning. Preserve
          // semantic corruption detection before using a rebuildable projection.
          for (const frame of inspection.frames.slice(0, checkpoint.revision))
            expected = reduce(expected, frame.record.transition, frame.record.revision);
          if (digestValue(saved) !== digestValue(expected))
            throw new Error("Checkpoint state does not match journal");
          projection = expected;
        } else if (checkpoint.state) {
          const snapshot = await verifyArtifact(directory, checkpoint.state);
          const frames = journalFrameSchema.array().parse(JSON.parse(snapshot.toString("utf8")));
          if (digestValue(frames) !== digestValue(inspection.frames.slice(0, checkpoint.revision)))
            throw new Error("Checkpoint state does not match journal");
        }
      } catch (cause) {
        replayWarnings.push(
          `Ignored invalid checkpoint; replayed the authoritative journal: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    const journal = await open(
      join(directory, "journal.jsonl"),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await journal.sync();
      const journalVersion = await journal.stat({ bigint: true });
      if (!journalVersion.isFile()) throw new StorageError("conflict", "Journal is not a file");
      await syncDirectory(directory);
      await assertOwner(directory, owner);
      return new DurableStore({
        directory,
        manifest,
        owner,
        frames: inspection.frames,
        journal,
        journalVersion,
        fault: options.fault,
        replayWarnings,
        projection,
      });
    } catch (error) {
      await journal.close();
      throw error;
    }
  }

  get replayState(): CoreState | undefined {
    return this.projection ? structuredClone(this.projection) : undefined;
  }

  get frames(): readonly JournalFrame[] {
    return structuredClone(this.committed);
  }

  async assertOwner(): Promise<void> {
    if (this.closed) throw new StorageError("owner_unconfirmed", "Store is closed");
    if (this.uncertain)
      throw new StorageError(
        "commit_unknown",
        "Store is fenced after uncertain IO; reconcile and retry by request ID",
      );
    await assertOwner(this.directory, this.owner);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async writeArtifact(bytes: Uint8Array): Promise<ArtifactRef> {
    const artifact = { digest: digestBytes(bytes), size: bytes.byteLength };
    const path = join(this.directory, "artifacts", artifact.digest);
    const published = this.publishedArtifacts.get(artifact.digest);
    if (published) {
      // Only this owner's completed publications enter the index. Existing bytes
      // after reopening still need sync; changed file versions require comparison
      // and sync again even when their current content is identical.
      if (sameArtifactVersion(published, await stat(path, { bigint: true }))) return artifact;
    }
    await publishImmutable(path, bytes, "artifact", this.fault);
    const version = await this.verifyPublication(artifact);
    const manifest = parseConversationManifest(bytes);
    if (manifest) {
      await verifyArtifact(this.directory, artifact);
      this.artifactChildren.set(
        artifact.digest,
        manifest.chunks.map((chunk) => chunk.artifact),
      );
    }
    // Windows filesystem timestamps can alias same-size edits, including on CI's
    // ARM64 volume. Reverify and flush bytes there rather than trusting metadata.
    if (process.platform !== "win32") this.publishedArtifacts.set(artifact.digest, version);
    return artifact;
  }

  private async verifyPublication(artifact: ArtifactRef): Promise<ArtifactVersion> {
    const file = await open(
      join(this.directory, "artifacts", artifact.digest),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile())
        throw new StorageError("conflict", `Published artifact is not a file: ${artifact.digest}`);
      const bytes = await file.readFile();
      const after = await file.stat({ bigint: true });
      if (
        !sameArtifactVersion(before, after) ||
        bytes.length !== artifact.size ||
        digestBytes(bytes) !== artifact.digest
      )
        throw new StorageError("conflict", `Published artifact changed: ${artifact.digest}`);
      return after;
    } finally {
      await file.close();
    }
  }

  putArtifact(bytes: Uint8Array): Promise<ArtifactRef> {
    const snapshot = Buffer.from(bytes);
    return this.serialize(async () => {
      await this.assertOwner();
      try {
        return await this.writeArtifact(snapshot);
      } catch (cause) {
        this.uncertain = true;
        throw new StorageError(
          "commit_unknown",
          "Artifact durability is uncertain; no transition was acknowledged",
          { cause },
        );
      }
    });
  }

  readArtifact(artifact: ArtifactRef): Promise<Buffer> {
    return verifyArtifactBytes(this.directory, artifact);
  }

  private async verifyReference(artifact: ArtifactRef): Promise<void> {
    const published = this.publishedArtifacts.get(artifact.digest);
    if (published && published.size === BigInt(artifact.size)) {
      // Reuse only this owner's completed publication while its file identity,
      // size and change timestamps still match. Otherwise verify the bytes.
      const current = await stat(join(this.directory, "artifacts", artifact.digest), {
        bigint: true,
      }).catch(() => undefined);
      if (current && sameArtifactVersion(published, current)) {
        for (const child of this.artifactChildren.get(artifact.digest) ?? [])
          await this.verifyChunkReference(child);
        return;
      }
    }
    await verifyArtifact(this.directory, artifact);
  }

  private async verifyChunkReference(artifact: ArtifactRef): Promise<void> {
    const published = this.publishedArtifacts.get(artifact.digest);
    if (published && published.size === BigInt(artifact.size)) {
      const current = await stat(join(this.directory, "artifacts", artifact.digest), {
        bigint: true,
      }).catch(() => undefined);
      if (current && sameArtifactVersion(published, current)) return;
    }
    await verifyArtifactBytes(this.directory, artifact);
  }

  async append(request: AppendRequest): Promise<JournalFrame> {
    const [frame] = await this.appendBatch([request]);
    return frame;
  }

  appendBatch(requests: readonly AppendRequest[]): Promise<JournalFrame[]> {
    const inputs = structuredClone(requests);
    return this.serialize(async () => {
      await this.assertOwner();
      const staged = new Map<string, JournalFrame>();
      const results: JournalFrame[] = [];
      let last = this.committed.at(-1);
      for (const input of inputs) {
        const prior = staged.get(input.requestId) ?? this.requests.get(input.requestId);
        if (prior) {
          if (
            prior.record.payloadDigest !== input.payloadDigest ||
            digestValue(prior.record.transition) !== digestValue(input.transition)
          )
            throw new StorageError(
              "conflict",
              "Request ID already committed with different content",
            );
          results.push(prior);
          continue;
        }
        // Duplicate retries may refer to older revisions, so chain only new frames.
        const record = journalRecordSchema.parse({
          schemaVersion: 1,
          revision: this.committed.length + staged.size + 1,
          requestId: input.requestId,
          payloadDigest: input.payloadDigest,
          previousDigest: last?.digest ?? "",
          transition: input.transition,
          artifacts: input.artifacts ?? [],
        });
        for (const artifact of record.artifacts) await this.verifyReference(artifact);
        const frame: JournalFrame = {
          record,
          digest: digestValue(record),
          commit: "pinata.commit.v1",
        };
        staged.set(input.requestId, frame);
        last = frame;
        results.push(frame);
      }
      if (!staged.size) return structuredClone(results);
      try {
        await this.assertOwner();
        const before = await stat(join(this.directory, "journal.jsonl"), { bigint: true });
        if (
          !sameArtifactVersion(before, this.journalVersion) ||
          !sameArtifactVersion(before, await this.journal.stat({ bigint: true }))
        )
          throw new StorageError("conflict", "Journal was edited or replaced while owned");
        let expectedSize = before.size;
        for (const frame of staged.values()) {
          const bytes = Buffer.from(JSON.stringify(frame) + "\n");
          await this.fault?.("journal.write.before");
          await this.journal.writeFile(bytes);
          expectedSize += BigInt(bytes.length);
          await this.fault?.("journal.write.after");
        }
        await this.fault?.("journal.sync.before");
        await this.journal.sync();
        await this.fault?.("journal.sync.after");
        await this.fault?.("journal.directory-sync.before");
        await syncDirectory(this.directory);
        await this.fault?.("journal.directory-sync.after");
        await this.assertOwner();
        const after = await this.journal.stat({ bigint: true });
        if (
          after.size !== expectedSize ||
          !sameArtifactVersion(
            after,
            await stat(join(this.directory, "journal.jsonl"), { bigint: true }),
          )
        )
          throw new StorageError("conflict", "Journal changed during append");
        this.journalVersion = after;
      } catch (cause) {
        this.uncertain = true;
        throw new StorageError(
          "commit_unknown",
          "Journal durability or ownership is uncertain; lookup/retry these exact requests after reconciliation",
          { cause },
        );
      }
      for (const frame of staged.values()) {
        this.committed.push(frame);
        this.requests.set(frame.record.requestId, frame);
      }
      return structuredClone(results);
    });
  }

  checkpoint(state?: CoreState): Promise<void> {
    const snapshot = state ? coreStateSchema.parse(state) : undefined;
    return this.serialize(async () => {
      await this.assertOwner();
      if (
        snapshot &&
        (snapshot.run !== this.manifest.run || snapshot.revision !== this.committed.length)
      )
        throw new StorageError(
          "conflict",
          "Checkpoint projection does not match this run revision",
        );
      const legacy = snapshot
        ? undefined
        : await this.writeArtifact(Buffer.from(canonicalJson(this.committed)));
      const checkpoint = checkpointSchema.parse({
        schemaVersion: 1,
        revision: this.committed.length,
        digest: this.committed.at(-1)?.digest ?? "",
        ...(snapshot ? { projection: "core", snapshot } : { state: legacy }),
      });
      // Checkpoints are rebuildable. A failed projection does not invalidate an
      // already-synced lifecycle transition or authorize new work on its own.
      await replaceProjection(
        join(this.directory, "checkpoints", "latest.json"),
        Buffer.from(canonicalJson(checkpoint)),
        "checkpoint",
        this.fault,
      );
    });
  }

  close(options: { retainOwner?: boolean } = {}): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) return;
      await this.journal.close();
      this.closed = true;
      if (this.uncertain) {
        throw new StorageError(
          "commit_unknown",
          "Uncertain store closed with its owner claim retained for reconciliation",
        );
      }
      if (!options.retainOwner) await releaseOwner(this.directory, this.owner);
    });
  }
}
