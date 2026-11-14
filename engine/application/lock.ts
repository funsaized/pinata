import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { applicationLeaseSchema, type ApplicationLease } from "../contracts/application.ts";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import { DomainError } from "../contracts/common.ts";
import {
  assertOwner,
  assertOwnerDead,
  claimOwner,
  readOwner,
  releaseOwner,
} from "../storage/owner.ts";
import { reconcileStore } from "../storage/reconcile.ts";
import { isMissing, replaceProjection, syncDirectory } from "../storage/io.ts";

// Application journals need one writer across processes. This lock does not
// track workers or prevent edits in the checkout; the coordinator arranges handoff.
const owned = new Set<string>();
const requestSchema = applicationLeaseSchema.pick({
  operationId: true,
  ownerEpoch: true,
  purpose: true,
});

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new DomainError("conflict", "Application metadata must be a real directory");
}

export class ApplicationLock {
  readonly checkout: ApplicationLease["checkout"];
  readonly directory: string;

  private constructor(checkout: ApplicationLease["checkout"], directory: string) {
    this.checkout = checkout;
    this.directory = directory;
  }

  static async open(root: string): Promise<ApplicationLock> {
    const canonical = await realpath(root);
    const info = await stat(canonical, { bigint: true });
    const metadata = join(canonical, ".pinata");
    await ensureDirectory(metadata);
    const applications = join(metadata, "applications");
    await ensureDirectory(applications);
    const directory = join(applications, "lock");
    await ensureDirectory(directory);
    return new ApplicationLock(
      { root: canonical, device: String(info.dev), inode: String(info.ino) },
      directory,
    );
  }

  private async assertCheckout(): Promise<void> {
    const root = await realpath(this.checkout.root);
    const info = await stat(root, { bigint: true });
    if (
      root !== this.checkout.root ||
      String(info.dev) !== this.checkout.device ||
      String(info.ino) !== this.checkout.inode
    )
      throw new DomainError("conflict", "Application destination directory changed");
    for (const path of [
      join(root, ".pinata"),
      join(root, ".pinata", "applications"),
      this.directory,
    ]) {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new DomainError("conflict", "Application metadata must be a real directory");
    }
  }

  async inspect(): Promise<ApplicationLease | undefined> {
    await this.assertCheckout();
    const path = join(this.directory, "lease.json");
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new DomainError("conflict", "Application lock record must be a regular file");
      const lease = applicationLeaseSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (lease.checkout.root !== this.checkout.root)
        throw new DomainError("conflict", "Application lock belongs to another destination");
      return lease;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async acquire(
    request: {
      operationId: string;
      ownerEpoch: string;
      purpose: ApplicationLease["purpose"];
    },
    signal?: AbortSignal,
  ): Promise<ApplicationLease> {
    signal?.throwIfAborted();
    const input = requestSchema.parse(request);
    await this.assertCheckout();
    const owner = await claimOwner(this.directory);
    if (await this.inspect()) {
      await releaseOwner(this.directory, owner);
      throw new DomainError(
        "owner_unconfirmed",
        "Reconcile the retained application before another handoff",
      );
    }
    const lease = applicationLeaseSchema.parse({
      schemaVersion: 1,
      kind: "exclusive",
      id: randomUUID(),
      checkout: this.checkout,
      owner,
      ...input,
    });
    await replaceProjection(
      join(this.directory, "lease.json"),
      Buffer.from(canonicalJson(lease)),
      "application.lock",
    );
    owned.add(owner.token);
    return lease;
  }

  async assert(lease: ApplicationLease): Promise<void> {
    await this.assertCheckout();
    await assertOwner(this.directory, lease.owner);
    if (
      !owned.has(lease.owner.token) ||
      digestValue((await this.inspect()) ?? null) !== digestValue(lease)
    )
      throw new DomainError("owner_unconfirmed", "Application no longer holds its operation lock");
  }

  async release(lease: ApplicationLease): Promise<void> {
    await this.assert(lease);
    await unlink(join(this.directory, "lease.json"));
    await syncDirectory(this.directory);
    await releaseOwner(this.directory, lease.owner);
    owned.delete(lease.owner.token);
  }

  // Reuse the storage owner's exact-identity recovery and retained evidence.
  // A missing operation record means no helper was authorized, or release finished.
  async recoverOwner(): Promise<void> {
    const owner = await readOwner(this.directory);
    if (!owner) return;
    assertOwnerDead(owner);
    await reconcileStore({
      directory: this.directory,
      expectedOwnerToken: owner.token,
      reason: "Recover interrupted application lock",
    });
  }

  async recover(expected: ApplicationLease): Promise<ApplicationLease> {
    const current = await this.inspect();
    if (!current || digestValue(current) !== digestValue(expected))
      throw new DomainError(
        "owner_unconfirmed",
        "Application recovery requires its exact retained lock",
      );
    if (owned.has(current.owner.token)) {
      await this.assert(current);
      return current;
    }
    assertOwnerDead(current.owner);
    await this.recoverOwner();
    const owner = await claimOwner(this.directory);
    if (digestValue((await this.inspect()) ?? null) !== digestValue(expected)) {
      await releaseOwner(this.directory, owner);
      throw new DomainError("owner_unconfirmed", "Application lock changed during recovery");
    }
    const recovered: ApplicationLease = {
      ...current,
      owner,
      checkout: this.checkout,
      purpose: "recovery",
    };
    await replaceProjection(
      join(this.directory, "lease.json"),
      Buffer.from(canonicalJson(recovered)),
      "application.lock.recovery",
    );
    owned.add(owner.token);
    return recovered;
  }
}
