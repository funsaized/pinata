// Install and exercise the actual root tarball and its declared runtime dependencies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPiSmoke } from "./pi-smoke.ts";
import { validateRelease } from "../../scripts/release-npm.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const npmBinary = process.platform === "win32" ? "npm.cmd" : "npm";
function npm(args: string[], cwd: string): string {
  const outcome = spawnSync(npmBinary, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 120_000,
  });
  assert.equal(outcome.status, 0, outcome.stderr || outcome.stdout);
  return outcome.stdout;
}
function pack(directory: string, destination: string) {
  const output = JSON.parse(
    npm(["pack", "--json", "--ignore-scripts", "--pack-destination", destination], directory),
  );
  return Object.values<{ filename: string; integrity: string; files: { path: string }[] }>(
    output,
  )[0];
}
async function main() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-rewrite-package-")));
  try {
    const candidate = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert(candidate.dependencies?.zod, "zod must be a runtime dependency");
    assert.equal(candidate.dependencies?.["cron-parser"], undefined);
    const packed = pack(root, directory);
    const installedLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
    validateRelease(`v${candidate.version}`, candidate, installedLock, packed);
    const files: string[] = packed.files.map((entry: { path: string }) =>
      entry.path.replaceAll("\\", "/"),
    );
    for (const path of [
      "engine/pi/extension.ts",
      "engine/index.ts",
      "engine/core/state.ts",
      "engine/contracts/extension.ts",
      "engine/pi/events.ts",
      "engine/ui/tree.ts",
      "engine/typescript.mjs",
      "bin/pinata.mjs",
      "agents/scout.md",
      "agents/builder.md",
      "agents/reviewer.md",
      "examples/relay/fleet.json",
      "docs/reference/catalog.json",
      "skills/subagents/SKILL.md",
      "examples/agents/delegator.md",
    ])
      assert(files.includes(path), `Missing ${path}`);
    assert(!files.some((path) => /^(rewrite|test|bench|node_modules)\//.test(path)));
    const prefix = join(directory, "prefix");
    await mkdir(prefix);
    const installManifest = {
      name: "pinata-package-fixture",
      version: "0.0.0",
      private: true,
      dependencies: { "pi-pinata": `file:${join(directory, packed.filename)}` },
    };
    const packages: Record<string, unknown> = {
      "": installManifest,
      "node_modules/pi-pinata": {
        version: candidate.version,
        resolved: `file:${join(directory, packed.filename)}`,
        integrity: packed.integrity,
        dependencies: candidate.dependencies,
        peerDependencies: candidate.peerDependencies,
        peerDependenciesMeta: candidate.peerDependenciesMeta,
        bin: candidate.bin,
      },
    };
    const pending = Object.keys(candidate.dependencies);
    for (const name of pending) {
      if (packages[`node_modules/${name}`]) continue;
      const moduleDirectory = join(root, "node_modules", name);
      const manifest = JSON.parse(await readFile(join(moduleDirectory, "package.json"), "utf8"));
      // npm 10's directory pack can run prepare despite --ignore-scripts. Strip
      // lifecycle metadata only from temporary offline dependency copies.
      const dependencyDirectory = join(directory, "runtime-dependencies", name);
      await cp(moduleDirectory, dependencyDirectory, { recursive: true, dereference: true });
      await writeFile(
        join(dependencyDirectory, "package.json"),
        JSON.stringify({ ...manifest, scripts: {} }),
      );
      const dependency = pack(dependencyDirectory, directory);
      const locked = installedLock.packages[`node_modules/${name}`];
      assert.equal(manifest.version, locked.version, `Installed ${name} differs from the lockfile`);
      packages[`node_modules/${name}`] = {
        ...locked,
        dev: false,
        resolved: `file:${join(directory, dependency.filename)}`,
        integrity: dependency.integrity,
      };
      pending.push(...Object.keys(manifest.dependencies ?? {}));
    }
    await writeFile(join(prefix, "package.json"), JSON.stringify(installManifest));
    await writeFile(
      join(prefix, "package-lock.json"),
      JSON.stringify({ ...installManifest, lockfileVersion: 3, requires: true, packages }),
    );
    npm(
      ["ci", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
      directory,
    );
    // Pi is an optional peer supplied by the host. Link the exact installed SDK
    // only after npm has independently installed the package's runtime dependencies.
    for (const name of ["zod"])
      assert((await realpath(join(prefix, "node_modules", name))).startsWith(prefix));
    const pureImports = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      const contracts = await import("pi-pinata/contracts");
      const runtime = await import("pi-pinata/runtime");
      assert.equal(typeof contracts.schemaRegistry["pinata.command.v2"].safeParse, "function");
      assert.equal(typeof runtime.Runtime.open, "function");
      console.log(JSON.stringify({ node: process.version, pureImports: true }));
    `,
      ],
      { cwd: prefix, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(pureImports.status, 0, pureImports.stderr || pureImports.stdout);
    await mkdir(join(prefix, "node_modules", "@earendil-works"), { recursive: true });
    for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"])
      await symlink(
        join(root, "node_modules", "@earendil-works", name),
        join(prefix, "node_modules", "@earendil-works", name),
        process.platform === "win32" ? "junction" : "dir",
      );
    const publicImports = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      const api = await import("pi-pinata");
      const runtime = await import("pi-pinata/runtime");
      const host = await import("pi-pinata/host");
      const sources = await import("pi-pinata/sources");
      assert.equal(api.Runtime, runtime.Runtime);
      assert.equal(api.openHost, host.openHost);
      assert.equal(api.defineAgent, host.defineAgent);
      assert.equal(api.bindRuntime, sources.bindRuntime);
      assert.equal(typeof api.openSavedSource, "function");
      const { z } = await import("zod");
      const agent = api.defineAgent({
        name: "package-typed",
        handoffDescription: "Installed typed agent",
        instructions: "Report optional data.",
        outputType: z.strictObject({ value: z.number() }),
      });
      assert.equal(agent.definition.outputType, "trusted:package-typed");
      const queried = await import(new URL(
        "./contracts/definition.ts?package-smoke=typed",
        import.meta.resolve("pi-pinata"),
      ).href);
      assert.deepEqual(queried.definitionSchema.parse(agent.definition), agent.definition);
      console.log(JSON.stringify({ node: process.version, publicImports: true }));
    `,
      ],
      { cwd: prefix, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(publicImports.status, 0, publicImports.stderr || publicImports.stdout);
    const installed = join(prefix, "node_modules", "pi-pinata");
    const command = (args: string[]) => {
      const outcome = spawnSync(process.execPath, [join(installed, "bin", "pinata.mjs"), ...args], {
        cwd: directory,
        env: { ...process.env, PI_OFFLINE: "1" },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(outcome.status, 0, outcome.stderr || outcome.stdout);
      return outcome.stdout;
    };
    const definitions = JSON.parse(command(["agents", "list", "--json"]));
    assert.match(JSON.stringify(definitions), /"name":"scout"/);
    assert.match(command(["schema", "pinata.command.v2", "--json"]), /requestId/);
    assert.match(command(["tools", "--json"]), /pinata_integrate/);
    const smoke = await runPiSmoke({ packageRoot: installed, installed: true });
    console.log(
      JSON.stringify({
        ...smoke,
        packageFiles: files.length,
        installedCli: true,
        runtimeDependencies: ["zod"],
        piPeers: "installed pinned SDK",
        publicImports: true,
        node: process.version,
        actualRootPackage: true,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
