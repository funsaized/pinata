import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("GitHub mirror publishes npm contents once, verifies repeats, and fails closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinata-mirror-test-"));
  try {
    const source = path.join(dir, "source");
    await fs.mkdir(path.join(source, "package"), { recursive: true });
    await fs.writeFile(
      path.join(source, "package/package.json"),
      JSON.stringify({
        name: "pi-pinata",
        version: "0.1.0",
        repository: { url: "git+https://github.com/funsaized/pinata.git" },
        scripts: { prepublishOnly: "this-must-not-run" },
      }),
    );
    await fs.writeFile(path.join(source, "package/README.md"), "Published npm content\n");
    execFileSync("tar", ["-czf", path.join(dir, "source.tgz"), "package"], { cwd: source });
    const bin = path.join(dir, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(
      path.join(bin, "npm"),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dir = process.env.MIRROR_TEST_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const target = path.join(dir, 'target.tgz');
const fail = (code) => { console.log(JSON.stringify({ error: { code } })); process.exit(1); };
const github = args.includes('https://npm.pkg.github.com');
if (args[0] === 'view') {
  if (!github) console.log(JSON.stringify(process.env.MIRROR_TEST_LATEST || '0.1.0'));
  else if (process.env.MIRROR_TEST_AUTH_ERROR) fail('E401');
  else if (fs.existsSync(target)) console.log(JSON.stringify('0.1.0'));
  else fail('E404');
} else if (args[0] === 'pack') {
  if (!args.includes('--ignore-scripts')) fail('SCRIPTS_ENABLED');
  if (path.isAbsolute(args[1])) {
    execFileSync('tar', ['-czf', path.join(process.cwd(), 'artifact.tgz'), 'package'], { cwd: path.dirname(args[1]) });
  } else fs.copyFileSync(github ? target : path.join(dir, 'source.tgz'), 'artifact.tgz');
  console.log(JSON.stringify([{ filename: 'artifact.tgz' }]));
} else if (args[0] === 'publish') {
  if (!github || !args.includes('--ignore-scripts')) fail('UNSAFE_PUBLISH');
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', args[1], 'package/package.json']));
  if (manifest.name !== '@funsaized/pi-pinata') fail('UNSCOPED_PACKAGE');
  fs.copyFileSync(args[1], target);
} else fail('UNEXPECTED_COMMAND');
`,
      { mode: 0o755 },
    );
    const script = fileURLToPath(new URL("../scripts/sync-github-package.mjs", import.meta.url));
    const run = (version = "latest", extra = {}) =>
      spawnSync(process.execPath, [script, version], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          MIRROR_TEST_DIR: dir,
          ...extra,
        },
      });
    const calls = async () =>
      (await fs.readFile(path.join(dir, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /"published":true,"verified":true/);
    assert((await calls()).find((args) => args[0] === "publish").includes("latest"));
    const repeat = run("0.1.0");
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.match(repeat.stdout, /"published":false,"verified":true/);
    assert.equal((await calls()).filter((args) => args[0] === "publish").length, 1);

    assert.notEqual(run("0.1.0", { MIRROR_TEST_AUTH_ERROR: "1" }).status, 0);
    const beforeInvalid = (await calls()).length;
    assert.notEqual(run("latest; exit 0").status, 0);
    assert.equal((await calls()).length, beforeInvalid);

    await fs.rm(path.join(dir, "target.tgz"));
    const backfill = run("0.1.0", { MIRROR_TEST_LATEST: "0.2.0" });
    assert.equal(backfill.status, 0, backfill.stderr);
    assert(
      (await calls())
        .filter((args) => args[0] === "publish")
        .at(-1)
        .includes("mirror"),
    );

    // A version existing at GitHub is not enough: its files must match npm.
    execFileSync("tar", ["-xzf", path.join(dir, "target.tgz")], { cwd: source });
    await fs.writeFile(path.join(source, "package/README.md"), "Unexpected GitHub content\n");
    execFileSync("tar", ["-czf", path.join(dir, "target.tgz"), "package"], { cwd: source });
    assert.notEqual(run().status, 0);
    assert.equal((await calls()).filter((args) => args[0] === "publish").length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
