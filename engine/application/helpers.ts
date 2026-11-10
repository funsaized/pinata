import { readFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import {
  cleanupReceiptSchema,
  type ArtifactPort,
  type CleanupReceipt,
} from "../contracts/backend.ts";
import { identitySchema, textSchema, DomainError } from "../contracts/common.ts";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import type { ExclusiveLease } from "../contracts/gate.ts";
import { isMissing, replaceProjection, type FaultHook } from "../storage/io.ts";
import { GitCommands, recoverGitCleanup } from "../workspace/git.ts";
import { verifiedArtifact } from "./files.ts";

const helperRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  leaseId: identitySchema,
  operationId: identitySchema,
  scopes: z.array(
    z.strictObject({
      directory: textSchema,
      ownerEpoch: identitySchema,
      cleanup: cleanupReceiptSchema.optional(),
    }),
  ),
});
type HelperRecord = z.infer<typeof helperRecordSchema>;
export type GitFactoryOptions = { directory: string; ownerEpoch: string; artifacts: ArtifactPort };
export type ApplicationHelperOptions = {
  directory: string;
  artifacts: ArtifactPort;
  ownerEpoch: string;
  fault?: FaultHook;
  createGit?: (options: GitFactoryOptions) => GitCommands;
  recoverGit?: typeof recoverGitCleanup;
};

// Helper intent is durable before the first command. A crashed validator cannot
// release checkout exclusion merely because its application intent was unpublished.
export class ApplicationHelpers {
  private readonly options: ApplicationHelperOptions;
  private lease?: ExclusiveLease;
  private scope?: GitCommands;
  constructor(options: ApplicationHelperOptions) {
    this.options = options;
  }

  attach(lease: ExclusiveLease): void {
    this.lease = lease;
  }
  private path(lease: ExclusiveLease): string {
    return join(this.options.directory, "helpers", `${digestValue(lease.id)}.json`);
  }
  private async read(lease: ExclusiveLease): Promise<HelperRecord> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.path(lease), "utf8"));
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { schemaVersion: 1, leaseId: lease.id, operationId: lease.operationId, scopes: [] };
    }
    const record = helperRecordSchema.parse(value);
    if (record.leaseId !== lease.id || record.operationId !== lease.operationId)
      throw new DomainError("conflict", "Application helper intent belongs to another lease");
    for (const scope of record.scopes) {
      const suffix = relative(join(this.options.directory, "git"), scope.directory);
      if (
        isAbsolute(suffix) ||
        suffix === ".." ||
        suffix.startsWith("../") ||
        suffix.startsWith("..\\")
      )
        throw new DomainError(
          "conflict",
          "Application helper scope lies outside its retained operation directory",
        );
      if (scope.cleanup)
        for (const evidence of scope.cleanup.evidence)
          await verifiedArtifact(this.options.artifacts, evidence);
    }
    return record;
  }
  private async publish(
    lease: ExclusiveLease,
    record: HelperRecord,
    phase: "intent" | "cleanup",
  ): Promise<void> {
    await replaceProjection(
      this.path(lease),
      Buffer.from(canonicalJson(record)),
      `application.helper.${phase}`,
      this.options.fault,
    );
  }

  async git(): Promise<GitCommands> {
    if (this.scope) return this.scope;
    const lease = this.lease;
    if (!lease) throw new Error("Application Git requires checkout exclusion");
    const record = await this.read(lease);
    if (record.scopes.some((scope) => scope.cleanup?.status !== "stopped"))
      throw new DomainError("owner_unconfirmed", "Prior application helper cleanup is unconfirmed");
    const options = {
      directory: join(this.options.directory, "git"),
      ownerEpoch: this.options.ownerEpoch,
      artifacts: this.options.artifacts,
    };
    const scope = this.options.createGit
      ? this.options.createGit(options)
      : new GitCommands(options);
    this.scope = scope;
    await this.publish(
      lease,
      {
        ...record,
        scopes: [...record.scopes, { directory: scope.directory, ownerEpoch: scope.ownerEpoch }],
      },
      "intent",
    );
    return scope;
  }

  async close(): Promise<CleanupReceipt> {
    const scope = this.scope;
    if (!scope)
      return {
        status: "stopped",
        ownerEpoch: this.options.ownerEpoch,
        identities: [],
        evidence: [],
      };
    const cleanup = cleanupReceiptSchema.parse(await scope.close());
    const lease = this.lease;
    if (!lease) throw new Error("Application helper lost its owning lease");
    const record = await this.read(lease);
    const scopes = record.scopes.map((entry) =>
      entry.directory === scope.directory && entry.ownerEpoch === scope.ownerEpoch
        ? { ...entry, cleanup }
        : entry,
    );
    // A failed intent publication never starts a command, but retaining cleanup
    // for that allocated scope makes later ownership inspection unambiguous.
    if (!scopes.some((entry) => entry.directory === scope.directory))
      scopes.push({ directory: scope.directory, ownerEpoch: scope.ownerEpoch, cleanup });
    await this.publish(lease, { ...record, scopes }, "cleanup");
    if (cleanup.status === "stopped") this.scope = undefined;
    return cleanup;
  }

  async recover(lease: ExclusiveLease): Promise<void> {
    this.lease = lease;
    const record = await this.read(lease);
    for (const entry of record.scopes) {
      if (entry.cleanup?.status === "stopped") continue;
      const recover = this.options.recoverGit ?? recoverGitCleanup;
      entry.cleanup = cleanupReceiptSchema.parse(
        await recover(entry.directory, entry.ownerEpoch, this.options.artifacts),
      );
      await this.publish(lease, record, "cleanup");
      if (entry.cleanup.status !== "stopped")
        throw new DomainError(
          "owner_unconfirmed",
          `Recovered application helper activity is unconfirmed; checkout exclusion is retained: ${entry.cleanup.reasons.join("; ")}`,
        );
    }
    this.scope = undefined;
  }

  async assertStopped(lease: ExclusiveLease): Promise<void> {
    const cleanup = await this.close();
    const record = await this.read(lease);
    if (
      cleanup.status !== "stopped" ||
      record.scopes.some((entry) => entry.cleanup?.status !== "stopped")
    )
      throw new DomainError(
        "owner_unconfirmed",
        "Application Git helper cleanup is unconfirmed; checkout exclusion is retained",
      );
  }
}
