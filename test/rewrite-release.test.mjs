import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { distTag, validateRelease } from "../scripts/release-npm.mjs";

const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url)));
const lock = JSON.parse(await fs.readFile(new URL("../package-lock.json", import.meta.url)));
const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "engine/index.ts",
  "engine/pi/extension.ts",
  "bin/pinata.mjs",
  "skills/subagents/SKILL.md",
  "agents/scout.md",
  "agents/builder.md",
  "agents/reviewer.md",
  "examples/agents/delegator.md",
  "docs/reference/catalog.json",
];
const packed = {
  name: manifest.name,
  version: manifest.version,
  filename: `${manifest.name}-${manifest.version}.tgz`,
  files: required.map((path) => ({ path })),
};
const tag = `v${manifest.version}`;

test("replacement release validates the new public surface without retired example roles", () => {
  validateRelease(tag, manifest, lock, packed);
  for (const path of [
    "engine/index.ts",
    "examples/agents/delegator.md",
    "docs/reference/catalog.json",
  ])
    assert.throws(
      () =>
        validateRelease(tag, manifest, lock, {
          ...packed,
          files: packed.files.filter((file) => file.path !== path),
        }),
      new RegExp(`Missing ${path.replaceAll(".", "\\.")}`),
    );
});

test("replacement release preserves publication metadata, hidden-file and exact-version checks", () => {
  for (const invalid of ["master", "v99.99.99", `${tag}-preview`, "v1.0.0-beta.1"])
    assert.throws(() => validateRelease(invalid, manifest, lock, packed));
  for (const changed of [{ name: "another-package" }, { publishConfig: {} }, { private: true }])
    assert.throws(() => validateRelease(tag, { ...manifest, ...changed }, lock, packed));
  assert.throws(() => validateRelease(tag, manifest, { ...lock, version: "0.0.0" }, packed));
  for (const path of [
    ".npmrc",
    "test/leak.mjs",
    "media/demo.mp4",
    "engine/.env",
    "engine/node_modules/x",
  ])
    assert.throws(() =>
      validateRelease(tag, manifest, lock, { ...packed, files: [...packed.files, { path }] }),
    );
  assert.equal(distTag("1.0.0-next.12"), "next");
  assert.equal(distTag("1.0.0"), "latest");
});
