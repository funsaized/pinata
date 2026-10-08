import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  atomic,
  command,
  digest,
  fileHash,
  exists,
  living,
  need,
  privateDir,
  processInfo,
  readJson,
  sleep,
} from "./core.mjs";
import { executable } from "./config.mjs";
import { copyDirectory } from "./copy.mjs";

const NPM_SETUP = "npm ci --prefer-offline --no-audit --no-fund";
const HOOKS = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
];

// Cache only npm's relocatable, registry-only installs without lifecycle hooks.
// Other managers, workspaces, native builds and custom setup retain their normal
// install path and package-manager download cache.
export async function dependencyKey(spec, env) {
  if (!spec.setup.cacheRoot || spec.setup.source !== "detected" || spec.setup.command !== NPM_SETUP)
    return null;
  try {
    const pkg = await readJson(path.join(spec.cwd, "package.json"));
    const lockName = (await exists(path.join(spec.cwd, "npm-shrinkwrap.json")))
      ? "npm-shrinkwrap.json"
      : "package-lock.json";
    const lock = await readJson(path.join(spec.cwd, lockName));
    if (
      pkg.workspaces ||
      pkg.gypfile ||
      HOOKS.some((h) => pkg.scripts?.[h]) ||
      ![2, 3].includes(lock.lockfileVersion) ||
      !lock.packages
    )
      return null;
    for (const [name, item] of Object.entries(lock.packages)) {
      if (item.hasInstallScript || item.link) return null;
      if (
        name &&
        (!name.startsWith("node_modules/") ||
          !(item.resolved ?? "").startsWith("https://") ||
          !item.integrity)
      )
        return null;
    }
    const ignored = await command([
      "git",
      "-C",
      spec.cwd,
      "check-ignore",
      "--no-index",
      "node_modules/.pinata-cache-probe",
    ]);
    if (ignored.code !== 0) return null;
    const tracked = await command(["git", "-C", spec.cwd, "ls-files", "--", "node_modules"]);
    if (tracked.code !== 0 || tracked.stdout) return null;
    const npm = await executable("npm");
    const [version, settings] = await Promise.all([
      command([npm, "--version"], { cwd: spec.cwd, env }),
      command([npm, "config", "list", "--json"], { cwd: spec.cwd, env }),
    ]);
    if (version.code || settings.code) return null;
    const config = JSON.parse(settings.stdout);
    // npm reports the current prefix in addition to effective settings.
    delete config.prefix;
    delete config["local-prefix"];
    const relevantEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !/^(?:PINATA_|PI_|HERDR_)/.test(key) &&
          !["TMPDIR", "PWD", "OLDPWD", "SHLVL", "_"].includes(key),
      ),
    );
    const stat = await fs.stat(npm);
    return digest({
      pkg,
      lock,
      npm,
      npmStat: [stat.size, stat.mtimeMs, stat.ctimeMs],
      version: version.stdout,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      config,
      env: relevantEnv,
    });
  } catch {
    return null;
  }
}

// Reject symlinks outside the prepared tree, devices and sockets. The content
// digest detects edits to retained cache files before they reach another task.
export async function dependencyDigest(root) {
  const entries = [];
  async function visit(rel) {
    const file = path.join(root, rel),
      st = await fs.lstat(file);
    if (st.isDirectory()) {
      entries.push([rel, "dir", st.mode & 0o777]);
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(rel, name));
    } else if (st.isSymbolicLink()) {
      const target = await fs.readlink(file),
        resolved = await fs.realpath(file);
      need(
        !path.isAbsolute(target) && resolved.startsWith(root + path.sep),
        "Dependency symlink leaves its tree",
      );
      entries.push([rel, "link", target]);
    } else {
      need(st.isFile(), "Dependency cache contains a special file");
      entries.push([rel, st.mode & 0o777, await fileHash(file)]);
    }
  }
  need((await fs.lstat(root)).isDirectory(), "Dependencies are not a directory");
  await visit("");
  return digest(entries);
}

export async function reuseDependencies(spec, { dir, env, executeCopy }, install) {
  const key = await dependencyKey(spec, env);
  if (!key) return install();
  const root = spec.setup.cacheRoot,
    entry = path.join(root, key),
    modules = path.join(spec.cwd, "node_modules");
  try {
    await privateDir(root);
  } catch {
    return install();
  }
  const restore = async () => {
    const ready = await readJson(path.join(entry, "ready.json")).catch(() => null);
    if (!ready || ready.key !== key) return null;
    const tree = path.join(entry, "node_modules");
    if (!(await fs.lstat(tree)).isDirectory()) return null;
    const staged = path.join(spec.cwd, `.pinata-deps-${randomUUID()}`);
    try {
      await copyDirectory(tree, staged, executeCopy);
      need(
        (await dependencyDigest(staged)) === ready.digest,
        "Dependency cache changed during copy",
      );
      await fs.rm(modules, { recursive: true, force: true });
      await fs.rename(staged, modules);
      return {
        code: 0,
        reason: null,
        terminated: true,
        command: spec.setup.command,
        cache: "hit",
        cacheKey: key,
      };
    } finally {
      await fs.rm(staged, { recursive: true, force: true });
    }
  };
  const recoverCache = (error) => {
    if (error.fatalCopy) throw error;
    return null;
  };
  const hit = await restore().catch(recoverCache);
  if (hit) return hit;
  const lock = path.join(root, `${key}.lock`);
  let handle;
  let emptyLockAt;
  while (!handle) {
    need(Date.now() < spec.deadline, "Task deadline exceeded during dependency preparation");
    need(!(await exists(path.join(dir, "cancel.json"))), "cancelled");
    try {
      const candidate = await fs.open(lock, "wx", 0o600);
      try {
        await candidate.writeFile(JSON.stringify(await processInfo(process.pid)));
      } catch {
        await candidate.close();
        await fs.unlink(lock).catch(() => {});
        return install();
      }
      handle = candidate;
    } catch (e) {
      if (e.code !== "EEXIST") return install();
      const owner = await readJson(lock).catch(() => null);
      if (!owner) {
        emptyLockAt ??= Date.now();
        if (Date.now() - emptyLockAt >= 1000) break;
      } else emptyLockAt = undefined;
      if (owner && !(await living([owner]).catch(() => [])).length) break; // Abandoned producer; install independently.
      const ready = await restore().catch(recoverCache);
      if (ready) return ready;
      await sleep(100);
    }
  }
  try {
    const ready = await restore().catch(recoverCache);
    if (ready) return ready;
    const result = await install();
    // Publish before Pi can edit the tree. A producer failure never publishes.
    const stage = path.join(root, `.pending-${randomUUID()}`);
    try {
      const fingerprint = await dependencyDigest(modules);
      await privateDir(stage);
      await copyDirectory(modules, path.join(stage, "node_modules"), executeCopy);
      need(
        (await dependencyDigest(path.join(stage, "node_modules"))) === fingerprint,
        "Dependencies changed during preparation",
      );
      await atomic(path.join(stage, "ready.json"), { key, digest: fingerprint });
      // Existing entries are immutable. Concurrent producers may safely race
      // to publish an equivalent entry; a corrupt entry is bypassed, not trusted.
      await fs.rename(stage, entry);
    } catch (error) {
      if (error.fatalCopy) throw error;
      /* Ineligible output/cache storage failure: ordinary setup remains valid. */
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
    return { ...result, cache: "miss", cacheKey: key };
  } finally {
    if (handle) {
      await handle.close();
      await fs.unlink(lock).catch(() => {});
    }
  }
}
