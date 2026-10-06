import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { readJson } from "../lib/core.mjs";
import { integrate } from "../lib/pinata.mjs";
import { fixture, task, settled } from "./helpers.mjs";

const write = async (cwd, file, data) => {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await fs.writeFile(path.join(cwd, file), data);
};

test("gitignored files named in .worktreeinclude reach every worktree but never integration", async (t) => {
  const f = await fixture(
    t,
    [
      task("look", "scout", {
        expect: { "ignored/config.json": '{"local":true}' },
        absent: ["ignored/other.txt"],
      }),
      task(
        "build",
        "builder",
        { expect: { "ignored/config.json": '{"local":true}' }, write: { "a.txt": "built" } },
        { ownership: ["a.txt"], noChecksReason: "Fixture text change inspected directly" },
      ),
      task("check", "reviewer", {}, { after: ["build"], reviewOf: "build" }),
    ],
    {
      async before({ cwd }) {
        await write(cwd, ".worktreeinclude", "ignored/config.json\n");
        await write(cwd, "ignored/config.json", '{"local":true}');
        await write(cwd, "ignored/other.txt", "not listed");
      },
    },
  );
  const s = await settled(f);
  assert.deepEqual(
    s.tasks.map((x) => x.status),
    ["succeeded", "succeeded", "succeeded"],
  );
  assert.deepEqual(s.tasks[0].included, ["ignored/config.json"]);
  assert.deepEqual(s.tasks[1].included, ["ignored/config.json"]);
  const integrated = await integrate(f.run);
  assert.equal(integrated.integration.status, "verified");
  const journal = await readJson(path.join(f.run, "integration", "journal.json"));
  assert.deepEqual(
    journal.entries.map((e) => e.path),
    ["a.txt"],
  );
});

test(".worktreeinclude copies only files that are ignored in the worktree", async (t) => {
  const f = await fixture(t, [task("look", "scout", { absent: ["notes.md"] })], {
    config: { includeUncommitted: false },
    async before({ cwd }) {
      await write(cwd, ".worktreeinclude", "notes.md\n");
      await write(cwd, "notes.md", "untracked but not ignored");
    },
  });
  const s = await settled(f);
  assert.equal(s.tasks[0].status, "succeeded");
  assert.equal(s.tasks[0].included, undefined);
});
