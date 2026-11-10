import assert from "node:assert/strict";
import { test } from "node:test";
import { isDocumentation, selectFiles } from "../scripts/vale.mjs";

test("reader scope preserves generated output, historical evidence and fixtures", () => {
  for (const path of [
    "README.md",
    "docs/reference/api.md",
    "docs/tutorials/first-run.md",
    "examples/README.md",
    "arena/README.md",
  ]) {
    assert.equal(isDocumentation(path), true, path);
  }
  for (const path of [
    "docs/reference/generated.md",
    "docs/maintainers/history.md",
    "docs/maintainers/rewrite-progress.md",
    "examples/relay/expected-report.md",
    "examples/relay/starter/REQUIREMENTS.md",
    "arena/corpus/prompt.md",
    "bench/results/report.md",
    "engine/index.ts",
  ]) {
    assert.equal(isDocumentation(path), false, path);
  }
});

test("operational instructions have their own scope", () => {
  for (const path of [
    "AGENTS.md",
    "STYLE.md",
    "agents/builder.md",
    "prompts/builder.md",
    "skills/subagents/SKILL.md",
    "examples/agents/delegator.md",
  ]) {
    assert.equal(isDocumentation(path), false, path);
    assert.equal(isDocumentation(path, true), true, path);
  }
  assert.equal(isDocumentation("README.md", true), false);
  assert.equal(isDocumentation("agents/config.json", true), false);
});

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("changed scan includes branch commits, working edits and untracked files, excluding deletions", () => {
  const directory = mkdtempSync(join(tmpdir(), "pinata-prose-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", directory);
    git("config", "user.name", "Prose test");
    git("config", "user.email", "prose@example.invalid");
    mkdirSync(join(directory, "docs"));
    for (const name of ["staged", "unstaged", "deleted", "committed"])
      writeFileSync(join(directory, "docs", `${name}.md`), "Original\n");
    git("add", ".");
    git("commit", "-m", "Initial prose");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(directory, "docs/committed.md"), "Branch change\n");
    git("add", ".");
    git("commit", "-m", "Branch prose");
    writeFileSync(join(directory, "docs/staged.md"), "Staged change\n");
    git("add", ".");
    writeFileSync(join(directory, "docs/unstaged.md"), "Working change\n");
    writeFileSync(join(directory, "docs/new page.md"), "New page\n");
    rmSync(join(directory, "docs/deleted.md"));
    const working = ["docs/new page.md", "docs/staged.md", "docs/unstaged.md"];
    assert.deepEqual(selectFiles({ directory, changed: true }), working);
    assert.deepEqual(selectFiles({ directory, changed: true, base }), [
      "docs/committed.md",
      ...working,
    ]);
    assert.throws(() => selectFiles({ directory, changed: true, base: "missing-reference" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const vale = resolve(".vale/bin/3.26.0", process.platform === "win32" ? "vale.exe" : "vale");
test(
  "configured rules remain advisory, skip code, and distinguish operational prose",
  { skip: !existsSync(vale) },
  () => {
    function lint(path, input) {
      const result = spawnSync(
        vale,
        [
          "--no-global",
          "--config=.vale.ini",
          "--no-exit",
          "--output=JSON",
          `--path=${path}`,
          "--ext=.md",
        ],
        { input, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return Object.values(JSON.parse(result.stdout)).flat();
    }
    const alerts = lint(
      "docs/example.md",
      "Great question! A sub-agent uses a work-tree.\n\nI hope this helps.\n",
    );
    assert(alerts.some((alert) => alert.Check === "Pinata.Terms"));
    assert(
      alerts.some(
        (alert) =>
          alert.Check === "ai-tells.ClosingPleasantries" && alert.Severity === "suggestion",
      ),
    );
    assert(alerts.every((alert) => alert.Severity !== "error"));
    assert.deepEqual(
      lint(
        "docs/example.md",
        "`sub-agent work-tree`\n\n```text\nGreat question! I hope this helps.\n```\n",
      ),
      [],
    );
    assert(
      !lint("agents/example.md", "Great question! I hope this helps.\n").some((alert) =>
        alert.Check.startsWith("ai-tells."),
      ),
    );
  },
);
