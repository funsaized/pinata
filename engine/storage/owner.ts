import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rmdir, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ownerSchema, type Owner } from "../contracts/index.ts";
import {
  isMissing,
  publishImmutable,
  readOptional,
  StorageError,
  syncDirectory,
  type FaultHook,
} from "./io.ts";

export const ownerClaimSchema = ownerSchema;
export type OwnerClaim = Owner;

async function ownStartIdentity(): Promise<string> {
  if (process.platform === "linux") {
    const [stat, boot] = await Promise.all([
      readFile("/proc/self/stat", "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const ticks = fields[19];
    if (!ticks) throw new StorageError("owner_unconfirmed", "Cannot read process start identity");
    return `linux:${boot.trim()}:${ticks}`;
  }
  if (process.platform === "darwin") {
    const { stdout } = await promisify(execFile)("ps", [
      "-p",
      String(process.pid),
      "-o",
      "lstart=",
    ]);
    if (!stdout.trim())
      throw new StorageError("owner_unconfirmed", "Cannot read process start identity");
    // This timestamp is diagnostic, not permission to kill a PID or steal ownership.
    return `darwin:${stdout.trim()}`;
  }
  if (process.platform === "win32") {
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks`,
      ],
      { windowsHide: true },
    );
    if (!/^\d+$/.test(stdout.trim()))
      throw new StorageError("owner_unconfirmed", "Cannot read Windows process start identity");
    return `win32:${stdout.trim()}`;
  }
  throw new StorageError(
    "owner_unconfirmed",
    `Unsupported owner identity platform: ${process.platform}`,
  );
}

export async function readOwner(directory: string): Promise<OwnerClaim | undefined> {
  const bytes = await readOptional(join(directory, "owner", "claim.json"));
  if (!bytes) return undefined;
  try {
    return ownerClaimSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (cause) {
    throw new StorageError(
      "owner_unconfirmed",
      "Malformed owner claim requires offline reconciliation",
      { cause },
    );
  }
}

export async function assertNoReconciliation(directory: string): Promise<void> {
  try {
    // The directory itself is the atomic fence, including before its record exists.
    await stat(join(directory, "reconciling"));
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new StorageError(
    "owner_unconfirmed",
    "Offline reconciliation is in progress or interrupted",
  );
}

export async function claimOwner(directory: string, fault?: FaultHook): Promise<OwnerClaim> {
  await assertNoReconciliation(directory);
  const owner: OwnerClaim = {
    schemaVersion: 1,
    host: hostname(),
    pid: process.pid,
    startIdentity: await ownStartIdentity(),
    token: randomUUID(),
    epoch: randomUUID(),
  };
  try {
    await mkdir(join(directory, "owner"), { mode: 0o700 });
  } catch (cause) {
    throw new StorageError(
      "owner_unconfirmed",
      "Run already has an owner or an incomplete claim; attach or reconcile its exact identity",
      { cause },
    );
  }
  // The owner directory remains as evidence after any failed claim publication.
  await assertNoReconciliation(directory);
  await publishImmutable(
    join(directory, "owner", "claim.json"),
    Buffer.from(JSON.stringify(owner)),
    "owner",
    fault,
  );
  await syncDirectory(join(directory, "owner"));
  await publishImmutable(
    join(directory, "owners", `${owner.epoch}.json`),
    Buffer.from(JSON.stringify(owner)),
    "owner-history",
  );
  await syncDirectory(directory);
  return owner;
}

export async function assertOwner(directory: string, owner: OwnerClaim): Promise<void> {
  const [, current] = await Promise.all([assertNoReconciliation(directory), readOwner(directory)]);
  if (
    !current ||
    current.token !== owner.token ||
    current.epoch !== owner.epoch ||
    current.startIdentity !== owner.startIdentity ||
    current.pid !== process.pid ||
    current.host !== hostname()
  ) {
    throw new StorageError(
      "owner_unconfirmed",
      "Run ownership changed; no further effect may dispatch",
    );
  }
}

export async function releaseOwner(directory: string, owner: OwnerClaim): Promise<void> {
  await assertOwner(directory, owner);
  await unlink(join(directory, "owner", "claim.json"));
  await rmdir(join(directory, "owner"));
  await syncDirectory(directory);
}

export function assertOwnerDead(owner: OwnerClaim): void {
  if (owner.host !== hostname())
    throw new StorageError("owner_unconfirmed", "Remote owner requires reconciliation on its host");
  if (process.platform === "linux") {
    const bootPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const previousBoot = new RegExp(`^linux:(${bootPattern}):[0-9]+$`).exec(
      owner.startIdentity,
    )?.[1];
    if (previousBoot) {
      let currentBoot: string;
      try {
        currentBoot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      } catch (cause) {
        throw new StorageError("owner_unconfirmed", "Cannot confirm the owner's boot identity", {
          cause,
        });
      }
      // A process from a different boot cannot survive. This exact identity also
      // avoids confusing its PID with an unrelated live process after a reboot.
      if (new RegExp(`^${bootPattern}$`).test(currentBoot) && previousBoot !== currentBoot) return;
    }
  }
  try {
    process.kill(owner.pid, 0);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return;
    throw new StorageError("owner_unconfirmed", "Owner liveness cannot be confirmed", { cause });
  }
  // A reused PID is deliberately not considered dead from a coarse timestamp.
  throw new StorageError(
    "owner_unconfirmed",
    "Owner PID is live; stop through its matching runtime before reconciliation",
  );
}
