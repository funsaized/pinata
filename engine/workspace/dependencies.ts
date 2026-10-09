// Builder setup (port of 0.7.0's resolveSetup, provision and reuseDependencies): detect the
// install command from root lockfiles, run it once per worktree and lockfile state, and reuse
// prepared npm dependencies across worktrees through a content-checked cache.
import { createHash, randomUUID } from "node:crypto";
import { constants, statSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { git, zsplit } from "./git.ts";
import { capture } from "./changes.ts";
import { environment, runCheck, type CheckEvidence } from "../verify/checks.ts";

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

// Root lockfiles and the strict install each implies. Every command refuses to rewrite its
// lockfile, so setup cannot produce deliverable changes.
const ECOSYSTEMS: Array<Array<[string, string, (files: string[]) => string]>> = [
  [
    ["pnpm-lock.yaml", "pnpm", () => "pnpm install --frozen-lockfile --prefer-offline"],
    ["bun.lock", "bun", () => "bun install --frozen-lockfile"],
    ["bun.lockb", "bun", () => "bun install --frozen-lockfile"],
    [
      "yarn.lock",
      "yarn",
      (files) =>
        files.includes(".yarnrc.yml")
          ? "yarn install --immutable"
          : "yarn install --frozen-lockfile",
    ],
    ["package-lock.json", "npm", () => NPM_SETUP],
    ["npm-shrinkwrap.json", "npm", () => NPM_SETUP],
  ],
  [
    ["uv.lock", "uv", () => "uv sync --frozen"],
    ["poetry.lock", "poetry", () => "poetry install --no-interaction"],
    ["Pipfile.lock", "pipenv", () => "pipenv sync"],
  ],
];
export const LOCKFILES = ECOSYSTEMS.flat().map(([file]) => file);

export interface Setup {
  command: string | null;
  source: "config" | "detected" | "disabled" | "none" | "not-needed";
  reason?: string;
  lockfiles?: string[];
}

function onPath(name: string): boolean {
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter))
    for (const ext of exts)
      try {
        if (statSync(join(dir, name + ext.toLowerCase())).isFile()) return true;
      } catch {
        // Not here.
      }
  return false;
}

// Resolves config.setup once per run: an explicit command, false, or lockfile detection.
export async function resolveSetup(
  setup: string | false | undefined,
  root: string,
  commit: string,
): Promise<Setup> {
  if (setup === false) return { command: null, source: "disabled" };
  if (typeof setup === "string") return { command: setup, source: "config" };
  const files = zsplit(await git(root, ["ls-tree", "--name-only", "-z", commit]));
  const commands: string[] = [];
  const lockfiles: string[] = [];
  for (const ecosystem of ECOSYSTEMS) {
    const found = ecosystem.filter(([file]) => files.includes(file));
    const managers = [...new Set(found.map(([, manager]) => manager))];
    if (managers.length > 1)
      return {
        command: null,
        source: "none",
        reason: `Conflicting lockfiles (${found.map(([f]) => f).join(", ")}); set config.setup`,
      };
    if (!found.length) continue;
    if (!onPath(managers[0]))
      return {
        command: null,
        source: "none",
        reason: `${found[0][0]} needs ${managers[0]}, which is not on PATH; install it or set config.setup`,
      };
    commands.push(found[0][2](files));
    lockfiles.push(...found.map(([file]) => file));
  }
  if (!commands.length)
    return { command: null, source: "none", reason: "No root lockfile detected" };
  return { command: commands.join(" && "), source: "detected", lockfiles };
}

// The shell a setup command runs in.
export function shellArgv(command: string): string[] {
  return process.platform === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
    : ["sh", "-c", command];
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(file, "utf8"));
}

// Only npm's relocatable, registry-only installs without lifecycle hooks are cached.
export async function dependencyKey(
  cwd: string,
  setup: Setup,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (setup.source !== "detected" || setup.command !== NPM_SETUP) return null;
  try {
    const pkg = await readJson(join(cwd, "package.json"));
    const lockName = (await lstat(join(cwd, "npm-shrinkwrap.json")).catch(() => null))
      ? "npm-shrinkwrap.json"
      : "package-lock.json";
    const lock = await readJson(join(cwd, lockName));
    if (
      pkg.workspaces ||
      pkg.gypfile ||
      HOOKS.some((h) => pkg.scripts?.[h]) ||
      ![2, 3].includes(lock.lockfileVersion) ||
      !lock.packages
    )
      return null;
    for (const [name, item] of Object.entries<any>(lock.packages)) {
      if (item.hasInstallScript || item.link) return null;
      if (
        name &&
        (!name.startsWith("node_modules/") ||
          !(item.resolved ?? "").startsWith("https://") ||
          !item.integrity)
      )
        return null;
    }
    const ignored = await git(
      cwd,
      ["check-ignore", "--no-index", "node_modules/.pinata-cache-probe"],
      { allowFailure: true },
    );
    if (!ignored.trim()) return null;
    if ((await git(cwd, ["ls-files", "--", "node_modules"])).trim()) return null;
    const relevantEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([k]) =>
          !/^(?:PINATA_|PI_|HERDR_)/.test(k) &&
          !["TMPDIR", "PWD", "OLDPWD", "SHLVL", "_"].includes(k),
      ),
    );
    return digest({
      pkg,
      lock,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      env: relevantEnv,
    });
  } catch {
    return null;
  }
}

// Rejects symlinks that leave the tree, devices and sockets; hashes content and modes.
export async function dependencyDigest(root: string): Promise<string> {
  const entries: unknown[] = [];
  const real = await realpath(root);
  async function visit(rel: string) {
    const file = join(root, rel);
    const st = await lstat(file);
    if (st.isDirectory()) {
      entries.push([rel, "dir", st.mode & 0o777]);
      for (const name of (await readdir(file)).sort()) await visit(rel ? join(rel, name) : name);
    } else if (st.isSymbolicLink()) {
      const target = await readlink(file);
      const resolved = await realpath(file);
      if (isAbsolute(target) || !resolved.startsWith(real + sep))
        throw new Error("Dependency symlink leaves its tree");
      entries.push([rel, "link", target]);
    } else {
      if (!st.isFile()) throw new Error("Dependency cache contains a special file");
      entries.push([
        rel,
        st.mode & 0o777,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ]);
    }
  }
  if (!(await lstat(root)).isDirectory()) throw new Error("Dependencies are not a directory");
  await visit("");
  return digest(entries);
}

async function copyTree(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    preserveTimestamps: true,
  });
}

export interface ProvisionOptions {
  worktree: string; // the builder's worktree
  baseTree: string; // its starting tree: setup must not change it
  setup: Setup;
  cacheRoot: string | null; // <git common dir>/pinata/cache/dependencies
  markerDir: string; // per-run setup markers
  task: string;
  root: string; // main checkout, exported as PINATA_ROOT
  passEnv: readonly string[];
  logDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProvisionResult {
  skipped?: boolean;
  cache?: "hit" | "miss";
  evidence?: CheckEvidence;
  key: string;
}

export class SetupError extends Error {
  override name = "SetupError";
  readonly evidence?: CheckEvidence;
  constructor(message: string, evidence?: CheckEvidence) {
    super(message);
    this.evidence = evidence;
  }
}

// Installs dependencies in a builder worktree once per setup command and lockfile state.
export async function provision(options: ProvisionOptions): Promise<ProvisionResult | null> {
  const { setup, worktree } = options;
  if (!setup.command) return null;
  const locks: Record<string, string> = {};
  for (const file of [...(setup.lockfiles ?? []), "package.json", "pyproject.toml", "Pipfile"]) {
    const data = await readFile(join(worktree, file)).catch(() => null);
    if (data) locks[file] = createHash("sha256").update(data).digest("hex");
  }
  const key = digest({ command: setup.command, locks });
  const marker = join(options.markerDir, `${options.task}.json`);
  if ((await readJson(marker).catch(() => null))?.key === key) return { skipped: true, key };
  const env = environment(options.passEnv, { PINATA_ROOT: options.root });
  const unchanged = async () => {
    const changes = await capture(worktree, options.baseTree);
    if (changes.changes.length)
      throw new SetupError(
        `Setup changed project files (${changes.changes
          .map((c) => c.path)
          .slice(0, 5)
          .join(", ")}); dependency output must be gitignored and lockfiles unchanged`,
      );
  };
  const install = async (): Promise<ProvisionResult> => {
    const evidence = await runCheck(
      { id: "setup", argv: shellArgv(setup.command!), timeoutMs: options.timeoutMs },
      { cwd: worktree, env, logDir: options.logDir, signal: options.signal },
    );
    if (!evidence.passed)
      throw new SetupError(
        `Setup failed (${evidence.reason ?? `exit ${evidence.code}`}); inspect ${evidence.stderr}`,
        evidence,
      );
    await unchanged();
    return { cache: "miss", evidence, key };
  };
  const cacheKey = options.cacheRoot ? await dependencyKey(worktree, setup, env) : null;
  const result = cacheKey
    ? await reuse(options.cacheRoot!, cacheKey, worktree, install)
    : await install();
  await unchanged();
  await mkdir(options.markerDir, { recursive: true, mode: 0o700 });
  await writeFile(marker, JSON.stringify({ key, at: Date.now() }), { mode: 0o600 });
  return result;
}

// Restores a cached node_modules, or installs and publishes one. Entries are immutable and
// checked against their digest on every restore; a corrupt entry is bypassed.
async function reuse(
  cacheRoot: string,
  key: string,
  worktree: string,
  install: () => Promise<ProvisionResult>,
): Promise<ProvisionResult> {
  const entry = join(cacheRoot, key);
  const modules = join(worktree, "node_modules");
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const restore = async (): Promise<ProvisionResult | null> => {
    const ready = await readJson(join(entry, "ready.json")).catch(() => null);
    if (!ready || ready.key !== key) return null;
    const staged = join(worktree, `.pinata-deps-${randomUUID()}`);
    try {
      await copyTree(join(entry, "node_modules"), staged);
      if ((await dependencyDigest(staged)) !== ready.digest) return null;
      await rm(modules, { recursive: true, force: true });
      await rename(staged, modules);
      return { cache: "hit", key };
    } catch {
      return null;
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  };
  const hit = await restore();
  if (hit) return hit;
  // One producer per key; others wait for it, then restore.
  const lock = join(cacheRoot, `${key}.lock`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let waited = 0; !handle; waited += 100) {
    try {
      handle = await open(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || waited > 600_000) return install();
      const ready = await restore();
      if (ready) return ready;
      // A lock older than ten minutes was abandoned.
      const st = await lstat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 600_000) await rm(lock, { force: true });
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    const ready = await restore();
    if (ready) return ready;
    const result = await install();
    const stage = join(cacheRoot, `.pending-${randomUUID()}`);
    try {
      const fingerprint = await dependencyDigest(modules);
      await mkdir(stage, { recursive: true, mode: 0o700 });
      await copyTree(modules, join(stage, "node_modules"));
      if ((await dependencyDigest(join(stage, "node_modules"))) === fingerprint) {
        await writeFile(join(stage, "ready.json"), JSON.stringify({ key, digest: fingerprint }), {
          mode: 0o600,
        });
        await rename(stage, entry);
      }
    } catch {
      // Ineligible output or cache storage failure: the ordinary install stays valid.
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
    return result;
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

export function relativeTo(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}
