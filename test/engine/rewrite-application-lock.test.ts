import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { ApplicationLock } from "../../engine/application/lock.ts";
import { ApplicationStore } from "../../engine/application/index.ts";
import { FixtureArtifacts } from "./rewrite-application-fixture.ts";

const childPath = fileURLToPath(
  new URL("./fixtures/rewrite-application-lock-child.ts", import.meta.url),
);
const request = { operationId: "handoff", ownerEpoch: "test", purpose: "apply" as const };

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pinata-application-lock-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "checkout");
  await mkdir(root);
  return { directory, root, lock: await ApplicationLock.open(root) };
}

test("application lock has one owner while ordinary checkout edits remain possible", async (t) => {
  const { root, lock } = await fixture(t);
  const other = await ApplicationLock.open(root);
  const attempts = await Promise.allSettled([lock.acquire(request), other.acquire(request)]);
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  const lease = await lock.inspect();
  assert(lease);
  await writeFile(join(root, "user.txt"), "shared edit\n");
  assert.equal(await readFile(join(root, "user.txt"), "utf8"), "shared edit\n");
  await lock.release(lease);
  const next = await other.acquire(request);
  await other.release(next);
  await assert.rejects(readFile(join(root, ".pinata", "checkout-gate", "manifest.json")), {
    code: "ENOENT",
  });
});

test(
  "application lock rejects live owners and recovers a crashed process with evidence",
  { timeout: 15000 },
  async (t) => {
    const { root, lock } = await fixture(t);
    const child = fork(childPath, [root], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    });
    await once(child, "message");
    const retained = await lock.inspect();
    assert(retained);
    await assert.rejects(lock.acquire(request), /owner/);
    await assert.rejects(lock.recover(retained), /live/);
    const exited = once(child, "exit");
    child.send("crash");
    await exited;
    const recovered = await lock.recover(retained);
    assert.equal(recovered.id, retained.id);
    assert.notEqual(recovered.owner.token, retained.owner.token);
    assert((await readdir(join(lock.directory, "evidence"))).length > 0);
    await lock.release(recovered);
    assert.equal(await lock.inspect(), undefined);
  },
);

test("reconcile releases a dead owner that never published an application operation", async (t) => {
  const { root, directory, lock } = await fixture(t);
  await assert.rejects(
    promisify(execFile)(process.execPath, [childPath, root, "before-operation"]),
    (error: unknown) => error instanceof Error && "code" in error && error.code === 85,
  );
  assert.equal(await lock.inspect(), undefined);
  const store = await ApplicationStore.open({
    destination: root,
    artifacts: new FixtureArtifacts(join(directory, "artifacts")),
  });
  assert.equal(await store.reconcile(), null);
  await store.close();
  const next = await lock.acquire(request);
  await lock.release(next);
});

test(
  "checkout aliases share the application lock",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, directory, lock } = await fixture(t);
    const alias = join(directory, "alias");
    await symlink(root, alias);
    const other = await ApplicationLock.open(alias);
    const lease = await lock.acquire(request);
    await assert.rejects(other.acquire(request), /owner/);
    await lock.release(lease);
  },
);

test("an aborted handoff does not claim the application lock", async (t) => {
  const { lock } = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(lock.acquire(request, controller.signal), /cancelled/);
  assert.equal(await lock.inspect(), undefined);
  await assert.rejects(readFile(join(lock.directory, "owner", "claim.json")), { code: "ENOENT" });
});

test("invalid handoff identities do not strand an application owner", async (t) => {
  const { lock } = await fixture(t);
  await assert.rejects(lock.acquire({ ...request, operationId: "" }));
  await assert.rejects(lock.acquire({ ...request, ownerEpoch: "" }));
  const lease = await lock.acquire(request);
  await lock.release(lease);
});

test("legacy pending application evidence requires recovery with the previous version", async (t) => {
  const { root, directory } = await fixture(t);
  const legacy = join(root, ".pinata", "checkout-gate");
  await mkdir(legacy);
  const evidence = '{"retained":"old application"}\n';
  await writeFile(join(legacy, "exclusive.json"), evidence);
  await assert.rejects(
    ApplicationStore.open({
      destination: root,
      artifacts: new FixtureArtifacts(join(directory, "artifacts")),
    }),
    /previous Piñata version/,
  );
  assert.equal(await readFile(join(legacy, "exclusive.json"), "utf8"), evidence);
});
