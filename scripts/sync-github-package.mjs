import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "pi-pinata";
const TARGET = "@funsaized/pi-pinata";
const NPM = "https://registry.npmjs.org";
const GITHUB = "https://npm.pkg.github.com";
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function npm(args, cwd) {
  return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function unpack(spec, registry, dir) {
  await fs.mkdir(dir);
  const [packed] = JSON.parse(
    npm(["pack", spec, "--registry", registry, "--ignore-scripts", "--json"], dir),
  );
  assert.equal(path.basename(packed.filename), packed.filename, "Unexpected tarball path");
  execFileSync("tar", ["-xzf", packed.filename, "--no-same-owner", "--no-same-permissions"], {
    cwd: dir,
  });
  return { root: path.join(dir, "package"), tarball: path.join(dir, packed.filename) };
}

async function contents(dir) {
  const result = {};
  for (const name of (await fs.readdir(dir, { recursive: true })).sort()) {
    const file = path.join(dir, name);
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) continue;
    assert(stat.isFile(), `Unexpected non-regular package file: ${name}`);
    const bytes = await fs.readFile(file);
    result[name] = {
      executable: Boolean(stat.mode & 0o111),
      content:
        name === "package.json"
          ? JSON.parse(bytes)
          : createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return result;
}

export async function mirror(requested = "latest") {
  assert(requested === "latest" || VERSION.test(requested), "Use latest or an exact npm version");
  const latest = JSON.parse(
    npm(["view", `${SOURCE}@latest`, "version", "--registry", NPM, "--json"]),
  );
  assert(typeof latest === "string" && VERSION.test(latest), "Invalid upstream latest version");
  const version = requested === "latest" ? latest : requested;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinata-package-sync-"));
  try {
    const { root: source } = await unpack(`${SOURCE}@${version}`, NPM, path.join(dir, "source"));
    const manifestPath = path.join(source, "package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(manifest.name, SOURCE, "Wrong upstream package");
    assert.equal(manifest.version, version, "Wrong upstream version");
    assert.equal(manifest.repository?.url, "git+https://github.com/funsaized/pinata.git");
    assert(!manifest.publishConfig, "Inspect upstream publishConfig before mirroring");
    manifest.name = TARGET;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const expected = await contents(source);

    let exists = false;
    try {
      const existing = JSON.parse(
        npm(["view", `${TARGET}@${version}`, "version", "--registry", GITHUB, "--json"]),
      );
      assert.equal(existing, version, "Unexpected target version");
      exists = true;
    } catch (error) {
      // Only a registry not-found response permits publication. Auth/network errors must fail.
      let code;
      try {
        code = JSON.parse(error.stdout).error?.code;
      } catch {
        throw error;
      }
      if (code !== "E404") throw error;
    }

    if (!exists) {
      const prepared = await unpack(source, GITHUB, path.join(dir, "prepared"));
      assert.deepEqual(await contents(prepared.root), expected, "Repacking changed npm contents");
      // Backfilling an older version must not move GitHub's latest tag backwards.
      const tag = version === latest ? "latest" : "mirror";
      console.log(`Publishing ${TARGET}@${version} with tag ${tag}`);
      npm([
        "publish",
        prepared.tarball,
        "--registry",
        GITHUB,
        "--tag",
        tag,
        "--ignore-scripts",
        "--provenance=false",
      ]);
    }

    const target = await unpack(`${TARGET}@${version}`, GITHUB, path.join(dir, "target"));
    assert.deepEqual(
      await contents(target.root),
      expected,
      "GitHub mirror differs from the npm artifact",
    );
    const result = { package: TARGET, version, published: !exists, verified: true };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mirror(process.argv[2]).catch((error) => {
    console.error(error.message);
    if (error.stderr) console.error(String(error.stderr));
    process.exitCode = 1;
  });
}
