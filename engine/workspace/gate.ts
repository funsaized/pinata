import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  checkoutIdentitySchema,
  exclusiveLeaseSchema,
  writerLeaseSchema,
  type CheckoutIdentity,
  type ExclusiveLease,
  type WriterLease,
} from "../contracts/gate.ts";
import { cleanupReceiptSchema, type CleanupReceipt } from "../contracts/backend.ts";
import { identitySchema, type AssignmentRef } from "../contracts/common.ts";
import { canonicalJson, digestValue } from "../contracts/digest.ts";
import type { Owner } from "../contracts/storage.ts";
import {
  isExisting,
  isMissing,
  publishImmutable,
  replaceProjection,
  StorageError,
  syncDirectory,
  writeSynced,
  type FaultHook,
} from "../storage/io.ts";
import { assertOwnerDead, claimOwner, readOwner, releaseOwner } from "../storage/owner.ts";

export { exclusiveLeaseSchema, writerLeaseSchema } from "../contracts/gate.ts";
export type { CheckoutIdentity, ExclusiveLease, WriterLease } from "../contracts/gate.ts";

export type CheckoutGateOptions = { fault?: FaultHook };
export type WriterRequest = { id?: string; ref: AssignmentRef; ownerEpoch: string };
export type ExclusiveRequest = {
  id?: string;
  operationId: string;
  ownerEpoch: string;
  purpose: ExclusiveLease["purpose"];
  wait?: boolean;
};
export type CheckoutGateState = {
  checkout: CheckoutIdentity;
  writers: WriterLease[];
  exclusive?: ExclusiveLease;
  mutex?: Owner;
};
type Mutation = { owner: Owner; retainOnFailure(): void };

// This process-local authority prevents a reused PID/coarse OS start timestamp
// from inheriting a live lease. Reopening a gate in this process retains it.
const ownedLeases = new Set<string>();
const exclusiveOperations = new Map<
  string,
  { checkout: string; pending: number; leases: Set<string> }
>();
const localKey = (lease: WriterLease | ExclusiveLease): string =>
  `${digestValue(lease.checkout)}/${lease.id}/${lease.owner.token}`;

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isExisting(error)) throw error;
  }
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new StorageError("conflict", `Checkout gate metadata must be a real directory: ${path}`);
}

async function readRecord(path: string): Promise<unknown | undefined> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new StorageError("conflict", `Checkout gate record is not a regular file: ${path}`);
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function identifyCheckout(root: string): Promise<CheckoutIdentity> {
  const canonical = await realpath(root);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory() || info.ino === 0n)
    throw new StorageError("conflict", "Checkout root lacks a stable directory identity");
  return { root: canonical, device: String(info.dev), inode: String(info.ino) };
}

export async function openCheckoutGate(
  root: string,
  options: CheckoutGateOptions = {},
): Promise<CheckoutGate> {
  const checkout = await identifyCheckout(root);
  const metadata = join(checkout.root, ".pinata");
  await ensureDirectory(metadata);
  const directory = join(metadata, "checkout-gate");
  await ensureDirectory(directory);
  for (const name of ["writers", "released", "evidence", "owners"])
    await ensureDirectory(join(directory, name));
  const manifest = { schemaVersion: 1, checkout };
  const previous = await readRecord(join(directory, "manifest.json"));
  if (previous !== undefined && digestValue(previous) !== digestValue(manifest))
    throw new StorageError("conflict", "Checkout gate belongs to a different directory identity");
  await publishImmutable(
    join(directory, "manifest.json"),
    Buffer.from(canonicalJson(manifest)),
    "gate-manifest",
  );
  await syncDirectory(metadata);
  await syncDirectory(checkout.root);
  return new CheckoutGate(checkout, directory, options);
}

export class CheckoutGate {
  readonly checkout: CheckoutIdentity;
  readonly directory: string;
  private readonly options: CheckoutGateOptions;

  constructor(checkout: CheckoutIdentity, directory: string, options: CheckoutGateOptions) {
    this.checkout = Object.freeze(checkoutIdentitySchema.parse(checkout));
    this.directory = directory;
    this.options = options;
  }

  private async assertCheckout(): Promise<void> {
    if (digestValue(await identifyCheckout(this.checkout.root)) !== digestValue(this.checkout))
      throw new StorageError("conflict", "Checkout directory changed while its gate was open");
    await ensureDirectory(join(this.checkout.root, ".pinata"));
    await ensureDirectory(this.directory);
    for (const name of ["writers", "released", "evidence", "owners"])
      await ensureDirectory(join(this.directory, name));
    for (const name of ["owner", "reconciling"]) {
      try {
        const entry = await lstat(join(this.directory, name));
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new StorageError(
            "conflict",
            "Checkout ownership metadata must be a real directory",
          );
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  private async mutex<T>(
    operation: (mutation: Mutation) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let owner: Owner;
    while (true) {
      signal?.throwIfAborted();
      await this.assertCheckout();
      try {
        owner = await claimOwner(this.directory, this.options.fault);
        break;
      } catch (error) {
        if (!(error instanceof StorageError) || !isExisting(error.cause)) throw error;
        const current = await readOwner(this.directory);
        if (current) {
          if (current.host !== hostname())
            throw new StorageError("owner_unconfirmed", "Checkout mutex belongs to another host");
          let dead = false;
          try {
            assertOwnerDead(current);
            dead = true;
          } catch (cause) {
            if (!(cause instanceof StorageError)) throw cause;
          }
          if (dead)
            throw new StorageError(
              "owner_unconfirmed",
              "Checkout mutex owner died; reconcile its exact retained claim",
            );
        }
        await delay(10, undefined, { signal });
      }
    }
    let retain = false;
    let releasing = false;
    try {
      await this.assertCheckout();
      const result = await operation({
        owner,
        retainOnFailure: () => {
          retain = true;
        },
      });
      releasing = true;
      await releaseOwner(this.directory, owner);
      return result;
    } catch (error) {
      if (!retain && !releasing) await releaseOwner(this.directory, owner);
      throw error;
    }
  }

  private writerPath(id: string): string {
    return join(this.directory, "writers", `${digestValue(id)}.json`);
  }

  private async records(): Promise<{ writers: WriterLease[]; exclusive?: ExclusiveLease }> {
    const writers: WriterLease[] = [];
    for (const name of (await readdir(join(this.directory, "writers"))).sort()) {
      if (name.startsWith(".unaccepted-")) continue;
      if (!/^[a-f0-9]{64}\.json$/.test(name))
        throw new StorageError(
          "conflict",
          "Unrecognized checkout writer evidence requires reconciliation",
        );
      const record = await readRecord(join(this.directory, "writers", name));
      if (record === undefined) continue;
      const lease = writerLeaseSchema.parse(record);
      if (
        digestValue(lease.checkout) !== digestValue(this.checkout) ||
        name !== `${digestValue(lease.id)}.json`
      )
        throw new StorageError("conflict", "Checkout writer identity does not match its gate");
      writers.push(lease);
    }
    const record = await readRecord(join(this.directory, "exclusive.json"));
    const exclusive = record === undefined ? undefined : exclusiveLeaseSchema.parse(record);
    if (exclusive && digestValue(exclusive.checkout) !== digestValue(this.checkout))
      throw new StorageError("conflict", "Exclusive checkout identity does not match its gate");
    if (exclusive && writers.length)
      throw new StorageError(
        "owner_unconfirmed",
        "Conflicting writer and exclusive gate records require reconciliation",
      );
    return { writers, ...(exclusive ? { exclusive } : {}) };
  }

  // Diagnostic only: all mutation methods reread these records under the mutex.
  async inspect(): Promise<CheckoutGateState> {
    await this.assertCheckout();
    return {
      checkout: this.checkout,
      ...(await this.records()),
      mutex: await readOwner(this.directory),
    };
  }

  private async waitForVacancy(kind: "writer" | "exclusive", signal?: AbortSignal): Promise<void> {
    while (true) {
      await delay(10, undefined, { signal });
      await this.assertCheckout();
      const state = await this.records();
      if (!state.exclusive && (kind === "writer" || !state.writers.length)) return;
    }
  }

  private async oneCheckout(
    operationId: string,
    operation: () => Promise<ExclusiveLease>,
  ): Promise<ExclusiveLease> {
    const key = digestValue(this.checkout);
    const held = exclusiveOperations.get(operationId) ?? {
      checkout: key,
      pending: 0,
      leases: new Set<string>(),
    };
    if (held.checkout !== key)
      throw new StorageError(
        "conflict",
        "An application operation cannot acquire a second checkout gate while holding another",
      );
    held.pending += 1;
    exclusiveOperations.set(operationId, held);
    try {
      const lease = await operation();
      held.leases.add(localKey(lease));
      return lease;
    } finally {
      held.pending -= 1;
      if (!held.pending && !held.leases.size) exclusiveOperations.delete(operationId);
    }
  }

  async registerWriter(request: WriterRequest, signal?: AbortSignal): Promise<WriterLease> {
    const id = identitySchema.parse(request.id ?? randomUUID());
    while (true) {
      const lease = await this.mutex(async (mutation) => {
        const state = await this.records();
        const existing = state.writers.find((writer) => writer.id === id);
        if (existing) {
          if (
            !ownedLeases.has(localKey(existing)) ||
            existing.ownerEpoch !== request.ownerEpoch ||
            digestValue(existing.ref) !== digestValue(request.ref)
          )
            throw new StorageError(
              "conflict",
              "Writer identity is already registered to another owner or assignment",
            );
          return existing;
        }
        if (state.exclusive) return undefined;
        if (await readRecord(join(this.directory, "released", `${digestValue(id)}.json`)))
          throw new StorageError("conflict", "Released writer identity cannot be registered again");
        const created = writerLeaseSchema.parse({
          schemaVersion: 1,
          kind: "writer",
          id,
          checkout: this.checkout,
          owner: mutation.owner,
          ownerEpoch: request.ownerEpoch,
          ref: request.ref,
        });
        mutation.retainOnFailure();
        await publishImmutable(
          this.writerPath(id),
          Buffer.from(canonicalJson(created)),
          "writer",
          this.options.fault,
        );
        ownedLeases.add(localKey(created));
        return created;
      }, signal);
      if (lease) return structuredClone(lease);
      await this.waitForVacancy("writer", signal);
    }
  }

  async acquireExclusive(request: ExclusiveRequest, signal?: AbortSignal): Promise<ExclusiveLease> {
    const id = identitySchema.parse(request.id ?? randomUUID());
    return this.oneCheckout(request.operationId, async () => {
      while (true) {
        const lease = await this.mutex(async (mutation) => {
          const state = await this.records();
          if (state.exclusive?.id === id) {
            if (
              !ownedLeases.has(localKey(state.exclusive)) ||
              state.exclusive.operationId !== request.operationId ||
              state.exclusive.ownerEpoch !== request.ownerEpoch
            )
              throw new StorageError(
                "conflict",
                "Exclusive identity is already registered to another owner or operation",
              );
            return state.exclusive;
          }
          if (state.exclusive || state.writers.length) {
            if (!request.wait)
              throw new StorageError(
                "owner_unconfirmed",
                "Checkout has registered activity; exclusive access requires confirmed writer cleanup",
              );
            return undefined;
          }
          if (await readRecord(join(this.directory, "released", `${digestValue(id)}.json`)))
            throw new StorageError(
              "conflict",
              "Released exclusive identity cannot be registered again",
            );
          const created = exclusiveLeaseSchema.parse({
            schemaVersion: 1,
            kind: "exclusive",
            id,
            checkout: this.checkout,
            owner: mutation.owner,
            ownerEpoch: request.ownerEpoch,
            operationId: request.operationId,
            purpose: request.purpose,
          });
          mutation.retainOnFailure();
          await publishImmutable(
            join(this.directory, "exclusive.json"),
            Buffer.from(canonicalJson(created)),
            "exclusive",
            this.options.fault,
          );
          ownedLeases.add(localKey(created));
          return created;
        }, signal);
        if (lease) return structuredClone(lease);
        await this.waitForVacancy("exclusive", signal);
      }
    });
  }

  private async removeWriter(
    lease: WriterLease,
    cleanup: CleanupReceipt,
    mutation: Mutation,
  ): Promise<void> {
    if (cleanup.status !== "stopped" || cleanup.ownerEpoch !== lease.ownerEpoch)
      throw new StorageError(
        "owner_unconfirmed",
        "Writer cleanup is unconfirmed or belongs to a different owner epoch",
      );
    mutation.retainOnFailure();
    await publishImmutable(
      join(this.directory, "released", `${digestValue(lease.id)}.json`),
      Buffer.from(canonicalJson({ lease, cleanup })),
      "writer-release",
      this.options.fault,
    );
    await this.options.fault?.("writer-release.remove.before");
    await unlink(this.writerPath(lease.id));
    await syncDirectory(join(this.directory, "writers"));
    await this.options.fault?.("writer-release.remove.after");
    ownedLeases.delete(localKey(lease));
  }

  async releaseWriter(id: string, input: CleanupReceipt): Promise<void> {
    const cleanup = cleanupReceiptSchema.parse(input);
    await this.mutex(async (mutation) => {
      const lease = (await this.records()).writers.find((writer) => writer.id === id);
      if (!lease) {
        const previous = await readRecord(
          join(this.directory, "released", `${digestValue(id)}.json`),
        );
        if (
          previous &&
          typeof previous === "object" &&
          "lease" in previous &&
          "cleanup" in previous
        ) {
          const released = writerLeaseSchema.parse(previous.lease);
          if (
            released.id === id &&
            digestValue(cleanup) === digestValue(cleanupReceiptSchema.parse(previous.cleanup))
          )
            return;
        }
        throw new StorageError(
          "conflict",
          "Writer lease is not registered with this cleanup receipt",
        );
      }
      if (!ownedLeases.has(localKey(lease)))
        throw new StorageError(
          "owner_unconfirmed",
          "Writer belongs to another process; reconcile its exact lease and cleanup evidence",
        );
      await this.removeWriter(lease, cleanup, mutation);
    });
  }

  async reconcileWriter(expected: WriterLease, input: CleanupReceipt): Promise<void> {
    const cleanup = cleanupReceiptSchema.parse(input);
    await this.mutex(async (mutation) => {
      const lease = (await this.records()).writers.find((writer) => writer.id === expected.id);
      if (!lease || digestValue(lease) !== digestValue(expected))
        throw new StorageError(
          "owner_unconfirmed",
          "Writer reconciliation requires its exact retained lease",
        );
      assertOwnerDead(lease.owner);
      if (!cleanup.evidence.length)
        throw new StorageError(
          "owner_unconfirmed",
          "Dead writer requires retained owned-activity cleanup evidence",
        );
      await this.removeWriter(lease, cleanup, mutation);
    });
  }

  async releaseExclusive(id: string): Promise<void> {
    await this.mutex(async (mutation) => {
      const lease = (await this.records()).exclusive;
      if (!lease || lease.id !== id) {
        const previous = await readRecord(
          join(this.directory, "released", `${digestValue(id)}.json`),
        );
        if (
          previous &&
          typeof previous === "object" &&
          "lease" in previous &&
          exclusiveLeaseSchema.parse(previous.lease).id === id
        )
          return;
        throw new StorageError("conflict", "Exclusive lease is not registered");
      }
      if (!ownedLeases.has(localKey(lease)))
        throw new StorageError(
          "owner_unconfirmed",
          "Exclusive lease belongs to another process; recover its exact operation",
        );
      mutation.retainOnFailure();
      await publishImmutable(
        join(this.directory, "released", `${digestValue(id)}.json`),
        Buffer.from(canonicalJson({ lease })),
        "exclusive-release",
        this.options.fault,
      );
      await unlink(join(this.directory, "exclusive.json"));
      await syncDirectory(this.directory);
      ownedLeases.delete(localKey(lease));
      const operation = exclusiveOperations.get(lease.operationId);
      operation?.leases.delete(localKey(lease));
      if (!operation?.pending && !operation?.leases.size)
        exclusiveOperations.delete(lease.operationId);
    });
  }

  async recoverExclusive(expected: ExclusiveLease): Promise<ExclusiveLease> {
    return this.oneCheckout(expected.operationId, () =>
      this.mutex(async (mutation) => {
        const lease = (await this.records()).exclusive;
        if (!lease || digestValue(lease) !== digestValue(expected))
          throw new StorageError(
            "owner_unconfirmed",
            "Exclusive recovery requires its exact retained operation lease",
          );
        if (ownedLeases.has(localKey(lease))) return structuredClone(lease);
        assertOwnerDead(lease.owner);
        const recovered = exclusiveLeaseSchema.parse({
          ...lease,
          owner: mutation.owner,
          purpose: "recovery",
        });
        mutation.retainOnFailure();
        await publishImmutable(
          join(this.directory, "evidence", `${randomUUID()}.json`),
          Buffer.from(canonicalJson({ previous: lease, recovered })),
          "exclusive-recovery",
          this.options.fault,
        );
        await replaceProjection(
          join(this.directory, "exclusive.json"),
          Buffer.from(canonicalJson(recovered)),
          "exclusive-recovery-claim",
          this.options.fault,
        );
        ownedLeases.add(localKey(recovered));
        return structuredClone(recovered);
      }),
    );
  }

  async reconcileMutex(expected: Owner, reason: string): Promise<void> {
    if (!reason.trim())
      throw new StorageError("conflict", "Checkout mutex reconciliation requires a reason");
    await this.assertCheckout();
    const observed = await readOwner(this.directory);
    if (!observed || digestValue(observed) !== digestValue(expected))
      throw new StorageError(
        "owner_unconfirmed",
        "Checkout mutex reconciliation requires the exact owner claim",
      );
    // A diagnostic snapshot may have caught another live mutation. Never fence
    // that owner while deciding whether its claim needs offline recovery.
    assertOwnerDead(observed);
    const fence = join(this.directory, "reconciling");
    await mkdir(fence, { mode: 0o700 });
    let mutated = false;
    try {
      const owner = await readOwner(this.directory);
      if (!owner || digestValue(owner) !== digestValue(expected))
        throw new StorageError(
          "owner_unconfirmed",
          "Checkout mutex reconciliation requires the exact owner claim",
        );
      assertOwnerDead(owner);
      const evidence = join(this.directory, "evidence", randomUUID());
      await mkdir(evidence, { mode: 0o700 });
      mutated = true;
      const record = Buffer.from(canonicalJson({ owner, reason, evidence }));
      await writeSynced(
        join(evidence, "reconciliation.json"),
        record,
        "gate-reconciliation-evidence",
        this.options.fault,
      );
      await writeSynced(
        join(fence, "intent.json"),
        record,
        "gate-reconciliation",
        this.options.fault,
      );
      await syncDirectory(fence);
      await syncDirectory(this.directory);
      await rename(join(this.directory, "owner"), join(evidence, "owner"));
      await syncDirectory(evidence);
      await syncDirectory(join(this.directory, "evidence"));
      await syncDirectory(this.directory);
      await unlink(join(fence, "intent.json"));
      await rmdir(fence);
      await syncDirectory(this.directory);
    } catch (error) {
      if (!mutated) await rmdir(fence);
      throw error;
    }
  }
}
