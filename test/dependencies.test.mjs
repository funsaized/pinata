import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { atomic, environment, sleep } from "../lib/core.mjs";
import { dependencyKey, reuseDependencies } from "../lib/dependencies.mjs";
import { repository } from "./repository.mjs";

async function setup(t) {
  const repo = await repository("pinata-dependency-cache-");
  t.after(() => fs.rm(repo.dir, { recursive: true, force: true }));
  await fs.appendFile(path.join(repo.cwd, ".gitignore"), "\nnode_modules/\n");
  const pkg = { name: "fixture", version: "1.0.0", dependencies: { dep: "1.0.0" } };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": pkg,
      "node_modules/dep": {
        version: "1.0.0",
        resolved: "https://example.invalid/dep.tgz",
        integrity: "sha512-fixture",
      },
    },
  };
  await atomic(path.join(repo.cwd, "package.json"), pkg);
  await atomic(path.join(repo.cwd, "package-lock.json"), lock);
  const spec = {
    cwd: repo.cwd,
    deadline: Date.now() + 60_000,
    setup: {
      source: "detected",
      command: "npm ci --prefer-offline --no-audit --no-fund",
      cacheRoot: path.join(repo.dir, "cache"),
    },
  };
  let calls = 0;
  const install = async (cwd = spec.cwd) => {
    calls++;
    await sleep(100);
    await fs.rm(path.join(cwd, "node_modules"), { recursive: true, force: true });
    await fs.mkdir(path.join(cwd, "node_modules/.bin"), { recursive: true });
    await fs.mkdir(path.join(cwd, "node_modules/dep"));
    await fs.writeFile(path.join(cwd, "node_modules/dep/cli.js"), "original", { mode: 0o755 });
    await fs.symlink("../dep/cli.js", path.join(cwd, "node_modules/.bin/dep"));
    return { code: 0, terminated: true };
  };
  return {
    ...repo,
    spec,
    pkg,
    lock,
    install,
    calls: () => calls,
    options: { dir: repo.dir, env: environment() },
  };
}

test("prepared dependencies are independent copies; corrupted entries are bypassed", async (t) => {
  const f = await setup(t);
  const cold = await reuseDependencies(f.spec, f.options, f.install);
  assert.equal(cold.cache, "miss");
  await fs.writeFile(path.join(f.cwd, "node_modules/dep/cli.js"), "worker edit");
  const warm = await reuseDependencies(f.spec, f.options, f.install);
  assert.equal(warm.cache, "hit");
  assert.equal(f.calls(), 1);
  assert.equal(await fs.readFile(path.join(f.cwd, "node_modules/dep/cli.js"), "utf8"), "original");
  const cached = path.join(f.spec.setup.cacheRoot, warm.cacheKey, "node_modules/dep/cli.js");
  assert.notEqual(
    (await fs.stat(cached)).ino,
    (await fs.stat(path.join(f.cwd, "node_modules/dep/cli.js"))).ino,
  );
  assert.equal(await fs.readlink(path.join(f.cwd, "node_modules/.bin/dep")), "../dep/cli.js");
  await fs.writeFile(cached, "corrupted");
  assert.equal((await reuseDependencies(f.spec, f.options, f.install)).cache, "miss");
  assert.equal(f.calls(), 2);
});

test("parallel preparations share one install; keys invalidate lock, package and environment changes", async (t) => {
  const f = await setup(t);
  const sibling = path.join(f.dir, "sibling");
  await fs.cp(f.cwd, sibling, { recursive: true });
  const spec2 = { ...f.spec, cwd: sibling };
  const [a, b] = await Promise.all([
    reuseDependencies(f.spec, f.options, f.install),
    reuseDependencies(spec2, f.options, () => f.install(sibling)),
  ]);
  assert.deepEqual([a.cache, b.cache].sort(), ["hit", "miss"]);
  assert.equal(f.calls(), 1);
  await fs.writeFile(path.join(sibling, "node_modules/dep/cli.js"), "sibling edit");
  assert.equal(await fs.readFile(path.join(f.cwd, "node_modules/dep/cli.js"), "utf8"), "original");
  const key = await dependencyKey(f.spec, f.options.env);
  assert.notEqual(await dependencyKey(f.spec, { ...f.options.env, npm_config_omit: "dev" }), key);
  await atomic(path.join(f.cwd, "package.json"), { ...f.pkg, description: "changed" });
  assert.notEqual(await dependencyKey(f.spec, f.options.env), key);
  await atomic(path.join(f.cwd, "package.json"), f.pkg);
  f.lock.packages["node_modules/dep"].integrity = "sha512-changed";
  await atomic(path.join(f.cwd, "package-lock.json"), f.lock);
  assert.notEqual(await dependencyKey(f.spec, f.options.env), key);
});

test("custom setup, hooks, local links and unsafe symlinks retain ordinary setup", async (t) => {
  const f = await setup(t);
  assert.equal(
    await dependencyKey({ ...f.spec, setup: { ...f.spec.setup, source: "config" } }, f.options.env),
    null,
  );
  await atomic(path.join(f.cwd, "package.json"), {
    ...f.pkg,
    scripts: { postinstall: "node build.js" },
  });
  assert.equal(await dependencyKey(f.spec, f.options.env), null);
  await atomic(path.join(f.cwd, "package.json"), f.pkg);
  f.lock.packages["node_modules/dep"].hasInstallScript = true;
  await atomic(path.join(f.cwd, "package-lock.json"), f.lock);
  assert.equal(await dependencyKey(f.spec, f.options.env), null);
  delete f.lock.packages["node_modules/dep"].hasInstallScript;
  f.lock.packages["node_modules/dep"].resolved = "file:../dep";
  await atomic(path.join(f.cwd, "package-lock.json"), f.lock);
  assert.equal(await dependencyKey(f.spec, f.options.env), null);
  f.lock.packages["node_modules/dep"].resolved = "https://example.invalid/dep.tgz";
  await atomic(path.join(f.cwd, "package-lock.json"), f.lock);
  const result = await reuseDependencies(f.spec, f.options, async () => {
    const result = await f.install();
    await fs.symlink(f.cwd, path.join(f.cwd, "node_modules/outside"));
    return result;
  });
  assert.equal(result.cache, "miss");
  assert.equal(
    await fs.stat(path.join(f.spec.setup.cacheRoot, result.cacheKey)).catch(() => null),
    null,
  );
});

test("failed installs never publish prepared dependencies", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    reuseDependencies(f.spec, f.options, async () => {
      throw new Error("install failed");
    }),
    /install failed/,
  );
  assert.deepEqual(await fs.readdir(f.spec.setup.cacheRoot), []);
});
