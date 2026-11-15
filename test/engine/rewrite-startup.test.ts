import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { canonicalJson, digestValue } from "../../engine/contracts/digest.ts";
import { writeRecord } from "../../engine/backends/process-transport.ts";

const execute = promisify(execFile);
const loader = new URL("../../engine/typescript.mjs", import.meta.url).href;
const cli = fileURLToPath(new URL("../../bin/pinata.mjs", import.meta.url));

test(
  "compile caching preserves CLI output when cold, warm, disabled or unavailable",
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pinata-startup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const cache = join(directory, "cache");
    const blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "retained");
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_COMPILE_CACHE: cache };
    delete env.NODE_DISABLE_COMPILE_CACHE;
    const outputs: string[] = [];
    for (const environment of [
      env,
      env,
      { ...env, NODE_DISABLE_COMPILE_CACHE: "1" },
      { ...env, NODE_COMPILE_CACHE: blocked },
    ]) {
      const result = await execute(
        process.execPath,
        [cli, "schema", "pinata.command.v1", "--json"],
        { env: environment },
      );
      outputs.push(result.stdout);
    }
    assert(outputs.every((output) => output === outputs[0]));
    assert(JSON.parse(outputs[0]).properties.command);
    assert((await readdir(cache)).length > 0);
    assert.equal(await readFile(blocked, "utf8"), "retained");
    const parent = await execute(
      process.execPath,
      [
        "--import",
        loader,
        "--input-type=module",
        "-e",
        `
    import { getCompileCacheDir, flushCompileCache } from "node:module";
    import { execFileSync } from "node:child_process";
    flushCompileCache();
    const child = execFileSync(process.execPath, ["--import", ${JSON.stringify(loader)}, "--input-type=module", "-e", 'import { getCompileCacheDir } from "node:module"; console.log(getCompileCacheDir())'], { encoding: "utf8" }).trim();
    console.log(JSON.stringify({ directory: getCompileCacheDir(), child, inherited: process.env.NODE_COMPILE_CACHE }));
  `,
      ],
      { env },
    );
    const inherited = JSON.parse(parent.stdout);
    assert.equal(inherited.child, inherited.directory);
    assert.equal(inherited.inherited, cache);
  },
);

test("process records retain canonical bytes and digests when payload serialization is shared", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pinata-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = { z: "🌲", a: [{ c: 3, a: 1 }, null], ignored: undefined };
  const path = join(directory, "record.json");
  await writeRecord(path, payload);
  assert.equal(
    await readFile(path, "utf8"),
    canonicalJson({ schemaVersion: 1, digest: digestValue(payload), payload }),
  );
});
