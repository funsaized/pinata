import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  PathError,
  assertNoLinks,
  caseInsensitive,
  checkWrite,
  repoRelative,
  toolPath,
} from "../../engine/workspace/paths.ts";
import { tempDir } from "./helpers.ts";

test("tool paths resolve like Pi's file tools", () => {
  assert.equal(toolPath("/repo", "@src/a.ts"), resolve("/repo", "src", "a.ts"));
  assert.equal(toolPath("/repo", "~/x"), join(homedir(), "x"));
  assert.equal(toolPath("/repo", "a\u00A0b.ts"), resolve("/repo", "a b.ts"));
});

test("repo-relative paths: table of accepted and refused inputs", async (t) => {
  const root = await tempDir(t);
  const cases: Array<[string, string | RegExp]> = [
    ["src/a.ts", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    [join(root, "src", "a.ts"), "src/a.ts"],
    ["src/../src/a.ts", "src/a.ts"],
    ["../outside.ts", /outside the workspace/],
    [join(root, "..", "x"), /outside the workspace/],
    [".git/config", /not a safe repository path/],
    ["src/.GIT/x", /not a safe repository path/],
    [".", /repository root itself/],
    ["", /A path is required/],
  ];
  for (const [input, expected] of cases) {
    if (typeof expected === "string")
      assert.equal(repoRelative(root, root, input), expected, input);
    else
      assert.throws(
        () => repoRelative(root, root, input),
        (e: Error) => e instanceof PathError && expected.test(e.message),
        input,
      );
  }
  if (process.platform === "win32") {
    assert.equal(repoRelative(root, root, "src\\a.ts"), "src/a.ts");
    assert.throws(() => repoRelative(root, root, "D:\\elsewhere\\x"), /outside the workspace/);
  }
});

test("writes are refused through symlinks or junctions and outside ownership", async (t) => {
  const root = await tempDir(t);
  const outside = await tempDir(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "x");
  await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => assertNoLinks(root, "link/x.ts"), /symlink or junction/);
  assert.throws(() => checkWrite(root, root, "link/x.ts", ["link"]), /symlink or junction/);
  assert.equal(checkWrite(root, root, "src/a.ts", ["src"]), "src/a.ts");
  assert.throws(
    () => checkWrite(root, root, "README.md", ["src"]),
    /outside this builder's ownership \(src\)/,
  );
  assert.equal(
    checkWrite(root, root, "SRC/a.ts", ["src"], true),
    "SRC/a.ts",
    "case-insensitive volumes match any case",
  );
  assert.throws(
    () => checkWrite(root, root, "SRC/a.ts", ["src"], false),
    /outside this builder's ownership/,
  );
});

test("case sensitivity is probed per volume", async (t) => {
  const root = await tempDir(t, "pinata-Case-");
  const expected =
    process.platform === "linux"
      ? false
      : process.platform === "win32"
        ? true
        : caseInsensitive(root);
  assert.equal(caseInsensitive(root), expected);
});

test("a write root given through a symlinked directory matches the real cwd an agent sees", async (t) => {
  if (process.platform === "win32") return t.skip("symlinks need privileges on Windows");
  const { mkdir, symlink, realpath } = await import("node:fs/promises");
  const base = await tempDir(t);
  await mkdir(join(base, "real"));
  await symlink(join(base, "real"), join(base, "link"));
  const real = await realpath(join(base, "real"));
  assert.equal(checkWrite(join(base, "link"), real, "a.txt", ["a.txt"]), "a.txt");
  assert.equal(
    checkWrite(join(base, "link"), real, join(base, "link", "a.txt"), ["a.txt"]),
    "a.txt",
  );
  assert.throws(() => checkWrite(join(base, "link"), real, "b.txt", ["a.txt"]), /ownership/);
});
