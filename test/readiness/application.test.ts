// These assertions document the frozen implementation, including its known failure.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { integrate, rollback } from "../../engine/verify/integrate.ts";
import { applicationFixture, nodeChild, readObject } from "./fixtures.ts";

const runner = new URL("./application-child.ts", import.meta.url);

test("baseline F1: terminal rollback with an old cursor produces false reapplication", async (t) => {
  const fixture = await applicationFixture(t);
  await integrate(fixture.dir);
  const cursorPath = join(fixture.dir, "integration/snapshots.json");
  const cursor = await readFile(cursorPath);
  await rollback(fixture.dir);
  await writeFile(cursorPath, cursor);
  const retry = await nodeChild(runner, ["apply", fixture.dir]);
  assert.equal(retry.code, 0, retry.stderr + retry.stdout);
  assert.equal(await readFile(join(fixture.root, "a.txt"), "utf8"), "base\n");
  t.diagnostic(JSON.stringify({ probe: "F1", falseSuccess: true }));
});

test(
  "baseline F1: real process death and IO failure across terminal journal writes",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const failure of ["kill", "throw"]) {
      for (const boundary of ["written", "synced", "renamed", "directory_synced"]) {
        const fixture = await applicationFixture(t);
        await integrate(fixture.dir);
        const fault = await nodeChild(runner, [
          "rollback",
          fixture.dir,
          `journal:rolled_back:${boundary}`,
          failure,
        ]);
        assert(
          failure === "kill" ? fault.signal === "SIGKILL" : fault.code === 2,
          fault.stderr + fault.stdout,
        );
        const journal = await readObject(join(fixture.dir, "integration/journal.json"));
        const cursor = await readObject(join(fixture.dir, "integration/snapshots.json"));
        assert.equal(await readFile(join(fixture.root, "a.txt"), "utf8"), "base\n");
        assert("build" in cursor);
        if (journal.status === "rolling_back") {
          const recover = await nodeChild(runner, ["rollback", fixture.dir]);
          assert.equal(recover.code, 0, recover.stderr + recover.stdout);
        }
        const retry = await nodeChild(runner, ["apply", fixture.dir]);
        assert.equal(retry.code, 0, retry.stderr + retry.stdout);
        const content = await readFile(join(fixture.root, "a.txt"), "utf8");
        const falseSuccess = journal.status === "rolled_back";
        assert.equal(content, falseSuccess ? "base\n" : "first\n");
        assert.equal(fixture.repo.git("rev-parse", "HEAD").trim(), fixture.head);
        assert.equal(fixture.repo.git("ls-files", "--stage"), fixture.index);
        assert.equal(await readFile(join(fixture.root, "other.txt"), "utf8"), "unrelated\n");
        t.diagnostic(
          JSON.stringify({
            probe: "F1",
            failure,
            boundary,
            durablePhase: journal.status,
            falseSuccess,
          }),
        );
      }
    }
  },
);

test(
  "baseline application can recover cursor-write interruptions without changing the index",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const boundary of ["written", "synced", "renamed", "directory_synced"]) {
      const fixture = await applicationFixture(t);
      const fault = await nodeChild(runner, ["apply", fixture.dir, `snapshots:any:${boundary}`]);
      assert.equal(fault.signal, "SIGKILL", fault.stderr + fault.stdout);
      const retry = await nodeChild(runner, ["apply", fixture.dir]);
      assert.equal(retry.code, 0, retry.stderr + retry.stdout);
      assert.equal(await readFile(join(fixture.root, "a.txt"), "utf8"), "first\n");
      assert.equal(fixture.repo.git("ls-files", "--stage"), fixture.index);
      t.diagnostic(JSON.stringify({ probe: "apply-cursor", boundary, recovered: true }));
    }
  },
);
