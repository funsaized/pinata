import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org";
const NAME = "pi-pinata";
const REPOSITORY = "git+https://github.com/funsaized/pinata.git";
const npm = (args) =>
  execFileSync("npm", [...args, "--registry", REGISTRY], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

export function validateRelease(tag, manifest, lock, packed) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/, "Release an exact stable vX.Y.Z tag");
  assert.equal(manifest.name, NAME);
  assert.equal(manifest.version, tag.slice(1), "Tag and package version differ");
  assert.equal(manifest.repository?.url, REPOSITORY);
  assert(!manifest.private && !manifest.publishConfig, "Unexpected publication settings");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.equal(packed.name, NAME);
  assert.equal(packed.version, manifest.version);
  assert.equal(packed.filename, `${NAME}-${manifest.version}.tgz`);
  const allowed = /^(?:package\.json|README\.md|LICENSE|(?:skills|prompts|lib|docs|examples)\/.+)$/;
  for (const { path: file } of packed.files) {
    assert(allowed.test(file), `Unexpected packed file: ${file}`);
    assert(!file.split("/").some((part) => part.startsWith(".") || part === "node_modules"));
  }
  for (const required of ["lib/pinata.mjs", "skills/subagents/SKILL.md", "skills/engmgmt/SKILL.md"])
    assert(
      packed.files.some((file) => file.path === required),
      `Missing ${required}`,
    );
}

async function published(version) {
  try {
    return JSON.parse(npm(["view", `${NAME}@${version}`, "--json", "--prefer-online"]));
  } catch (error) {
    let code;
    try {
      code = JSON.parse(error.stdout).error?.code;
    } catch {
      throw error;
    }
    if (code !== "E404") throw error;
    return null;
  }
}

export async function release(tag) {
  const manifest = JSON.parse(await fs.readFile("package.json", "utf8"));
  const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinata-release-"));
  try {
    const [packed] = JSON.parse(
      npm(["pack", "--ignore-scripts", "--json", "--pack-destination", dir]),
    );
    validateRelease(tag, manifest, lock, packed);
    const tarball = path.join(dir, packed.filename);
    const integrity =
      "sha512-" +
      createHash("sha512")
        .update(await fs.readFile(tarball))
        .digest("base64");
    assert.equal(integrity, packed.integrity);
    const existing = await published(manifest.version);
    if (!existing) {
      assert.equal(npm(["whoami"]).trim(), "funsaized", "Unexpected npm publisher");
      console.log(`Publishing ${NAME}@${manifest.version}: ${packed.files.length} inspected files`);
      npm(["publish", tarball, "--access", "public", "--provenance", "--ignore-scripts"]);
    }
    // A retry can only accept the exact tarball already on npm, never another build.
    let remote;
    for (let attempt = 0; attempt < 24; attempt++) {
      remote = await published(manifest.version);
      if (remote) break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    assert(
      remote,
      "Published version not visible after 2 minutes; inspect the registry before retrying",
    );
    assert.equal(remote.name, NAME);
    assert.equal(remote.version, manifest.version);
    assert.equal(remote.repository?.url, REPOSITORY);
    assert.equal(
      remote.dist?.integrity,
      integrity,
      "Registry artifact differs from inspected tarball",
    );
    console.log(
      JSON.stringify({ package: NAME, version: manifest.version, integrity, verified: true }),
    );
    if (process.env.GITHUB_OUTPUT)
      await fs.appendFile(process.env.GITHUB_OUTPUT, `version=${manifest.version}\n`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await release(process.argv[2]);
