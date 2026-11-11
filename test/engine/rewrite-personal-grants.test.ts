import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPersonalGrants } from "../../engine/pi/grants.ts";
import { grantsSchema } from "../../engine/contracts/index.ts";

test("personal grants are explicit, validated and fail closed when malformed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pinata-grants-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await readPersonalGrants(directory), undefined);
  await mkdir(join(directory, "pinata"));
  const path = join(directory, "pinata", "grants.json");
  const grants = grantsSchema.parse({
    access: "read",
    inheritContext: false,
    memory: { scope: "none", access: "read" },
    tools: ["read"],
    workspaces: ["shared"],
    delegation: { maxDepth: 2, agents: ["scout"], tools: ["read"], workspaces: ["shared"] },
  });
  await writeFile(path, JSON.stringify(grants));
  assert.deepEqual(await readPersonalGrants(directory), grants);
  for (const invalid of ["{", '{"access":"everything"}', '{"delegation":{"maxDepth":-1}}']) {
    await writeFile(path, invalid);
    await assert.rejects(readPersonalGrants(directory), /Invalid personal Pinata grants/);
  }
});
