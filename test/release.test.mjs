import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { validateRelease } from "../scripts/release-npm.mjs";

const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url)));
const lock = JSON.parse(await fs.readFile(new URL("../package-lock.json", import.meta.url)));
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  }),
);
const tag = `v${manifest.version}`;

test("release accepts the actual package artifact", () => {
  validateRelease(tag, manifest, lock, packed);
});

test("release rejects mismatched refs, metadata, lockfiles and unexpected contents", () => {
  for (const invalid of ["master", "v99.99.99", `${tag}-preview`])
    assert.throws(() => validateRelease(invalid, manifest, lock, packed));
  for (const changed of [{ name: "another-package" }, { publishConfig: {} }, { private: true }])
    assert.throws(() => validateRelease(tag, { ...manifest, ...changed }, lock, packed));
  assert.throws(() => validateRelease(tag, manifest, { ...lock, version: "0.0.0" }, packed));
  for (const file of [
    ".npmrc",
    "test/leak.mjs",
    "media/demo.mp4",
    "lib/.env",
    "lib/node_modules/x",
  ]) {
    assert.throws(() =>
      validateRelease(tag, manifest, lock, { ...packed, files: [...packed.files, { path: file }] }),
    );
  }
  assert.throws(() => validateRelease(tag, manifest, lock, { ...packed, files: [] }));
});
