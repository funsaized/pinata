// Checkout-level exclusion for Pinata writers and application. No age-based lock stealing.
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { open, readdir, realpath, unlink } from "node:fs/promises";
import { atomicJson, privateDir, readJson, runsRoot } from "../core/store.ts";
export interface WriterOwner {
  id: string;
  run: string;
  worker: string;
  assignment: number;
  host: string;
  pid: number;
}
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(resolve(path));
    if (parent === resolve(path)) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}
export async function gateDirectory(root: string, storageRoot?: string): Promise<string> {
  const canonical = await canonicalPath(root);
  return join(
    storageRoot ?? (await runsRoot(canonical)),
    "destinations",
    createHash("sha256").update(canonical).digest("hex"),
  );
}
async function withGate<T>(
  root: string,
  work: (folder: string) => Promise<T>,
  storageRoot?: string,
  signal?: AbortSignal,
): Promise<T> {
  const folder = await gateDirectory(root, storageRoot);
  await privateDir(folder);
  await privateDir(join(folder, "writers"));
  const file = join(folder, "gate.lock");
  // A brief metadata transaction. Contention is visible, and never treated as a stale lease.
  let lock;
  for (;;) {
    signal?.throwIfAborted();
    try {
      lock = await open(file, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Metadata transactions are short. Wait for a known local participant, never steal.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const owner = await readJson<{ pid: number; host: string }>(file).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw new Error(`Checkout gate needs reconciliation: ${file}`, { cause: error });
        },
      );
      if (!owner) continue;
      let live = false;
      if (owner.host === hostname())
        try {
          process.kill(owner.pid, 0);
          live = true;
        } catch (error) {
          live = (error as NodeJS.ErrnoException).code === "EPERM";
        }
      if (!live)
        throw new Error(
          `Checkout gate needs owner reconciliation: ${file}. Never remove it solely because of age.`,
        );
    }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
    await lock.sync();
    return await work(folder);
  } finally {
    await lock.close();
    await unlink(file);
  }
}
export async function registerWriter(
  root: string,
  identity: Pick<WriterOwner, "run" | "worker" | "assignment">,
  storageRoot?: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const id = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const owner: WriterOwner = { ...identity, id, host: hostname(), pid: process.pid };
  const file = await withGate(
    root,
    async (folder) => {
      const exclusive = await readJson(join(folder, "application.json")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (exclusive)
        throw new Error(
          `Checkout application is active or interrupted: ${join(folder, "application.json")}. Reconcile the journal before starting writable work.`,
        );
      const path = join(folder, "writers", `${id}.json`);
      const existing = await readJson<WriterOwner>(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) {
        if (
          existing.run !== identity.run ||
          existing.worker !== identity.worker ||
          existing.assignment !== identity.assignment
        )
          throw new Error(`Writer identity needs reconciliation: ${path}`);
      } else await atomicJson(path, owner);
      return path;
    },
    storageRoot,
    signal,
  );
  return () =>
    withGate(
      root,
      async () => {
        await unlink(file);
      },
      storageRoot,
    );
}
const processSession = randomUUID();
const activeApplications = new Set<string>();
export interface ApplicationOptions {
  signal?: AbortSignal;
  operation?: string;
  recover?: boolean;
  retainOnError?(): Promise<boolean>;
}
export async function withApplication<T>(
  root: string,
  work: () => Promise<T>,
  options: ApplicationOptions = {},
): Promise<T> {
  const token = randomUUID();
  const file = await withGate(
    root,
    async (folder) => {
      const writers = await readdir(join(folder, "writers"));
      if (writers.length)
        throw new Error(
          `Application requires a quiescent checkout: ${writers.length} active or unreconciled writer(s) in ${join(folder, "writers")}`,
        );
      const path = join(folder, "application.json");
      const existing = await readJson<{
        token: string;
        pid: number;
        host: string;
        session?: string;
        operation?: string;
      }>(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) {
        let canRecover =
          !!options.operation &&
          existing.operation === options.operation &&
          existing.session === processSession &&
          !activeApplications.has(path);
        if (
          !canRecover &&
          options.recover &&
          existing.operation === options.operation &&
          existing.host === hostname()
        ) {
          let live = true;
          try {
            process.kill(existing.pid, 0);
          } catch (error) {
            live = (error as NodeJS.ErrnoException).code !== "ESRCH";
          }
          canRecover = !live;
        }
        if (!canRecover)
          throw new Error(`Application is active or needs journal/owner reconciliation: ${path}`);
      }
      await atomicJson(path, {
        token,
        session: processSession,
        pid: process.pid,
        host: hostname(),
        operation: options.operation,
      });
      activeApplications.add(path);
      return path;
    },
    undefined,
    options.signal,
  );
  let retain = false;
  try {
    return await work();
  } catch (error) {
    retain = (await options.retainOnError?.()) ?? false;
    throw error;
  } finally {
    activeApplications.delete(file);
    if (!retain)
      await withGate(root, async () => {
        const owner = await readJson<{ token: string }>(file);
        if (owner.token !== token) throw new Error(`Application ownership changed: ${file}`);
        await unlink(file);
      });
  }
}
