// The packed package inside the real Pi: `npm pack`, install the tarball into a temporary
// prefix, and load it with `pi -e <package dir>` (a temporary package; never `pi install`).
// Pi must discover the tools, skills and prompts, and a faux-provider job must run through
// the tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { piCommand, rpc } from "./pi-smoke.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function npm(args: string[], cwd: string) {
  const r = spawnSync(NPM, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "pinata-package-smoke-"));
  try {
    const packed = JSON.parse(
      npm(["pack", "--json", "--ignore-scripts", "--pack-destination", dir], ROOT),
    )[0];
    const files: string[] = packed.files.map((f: { path: string }) => f.path.replaceAll("\\", "/"));
    for (const need of [
      "engine/pi/extension.ts",
      "engine/agent/extension.ts",
      "engine/core/engine.ts",
      "skills/subagents/SKILL.md",
      "skills/engmgmt/SKILL.md",
    ])
      assert(files.includes(need), `missing ${need}`);
    assert.equal(files.filter((f) => f.startsWith("prompts/")).length, 7);
    assert(
      !files.some((f) =>
        /^(test|bench|node_modules|\.github)\/|ENGINE_PLAN\.md|PLAN\.md|\.log$|\.env/.test(f),
      ),
      "development files in tarball",
    );
    const prefix = join(dir, "prefix");
    npm(
      [
        "install",
        "--prefix",
        prefix,
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        join(dir, packed.filename),
      ],
      dir,
    );
    const installed = join(prefix, "node_modules", "pi-pinata");
    const repo = join(dir, "repo");
    const agent = join(dir, "agent");
    await mkdir(repo, { recursive: true });
    await mkdir(agent, { recursive: true });
    await writeFile(join(repo, "README.md"), "# Package fixture\n");
    for (const args of [
      ["init", "-q"],
      ["add", "-A"],
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "init",
      ],
    ])
      assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0);
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({ quietStartup: true, retry: { enabled: false } }),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    delete env.PINATA_AGENT;
    delete env.PINATA_LEGACY;
    const pi = rpc(
      [
        ...piCommand(),
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--extension",
        installed,
        "--extension",
        join(ROOT, "test", "engine", "fixtures", "faux-extension.ts"),
        "--provider",
        "faux",
        "--model",
        "faux-1",
        "--thinking",
        "off",
      ],
      { cwd: repo, env },
    );
    try {
      const id = pi.send({ type: "get_commands" });
      const response = await pi.wait((r) => r.type === "response" && r.id === id);
      const names: string[] = response.data.commands.map((c: { name: string }) => c.name);
      for (const name of [
        "skill:subagents",
        "skill:engmgmt",
        "scout",
        "research",
        "planner",
        "builder",
        "reviewer",
        "pinata-review",
        "pinata-fix",
        "pinata",
      ])
        assert(names.includes(name), `missing command ${name}: ${names.join(", ")}`);
      pi.send({ type: "prompt", message: "smoke-foreground: run pinata" });
      const end = await pi.wait(
        (r) => r.type === "tool_execution_end" && r.toolName === "pinata_run",
        120_000,
      );
      const result = end.result?.details?.result;
      assert.equal(result?.status, "succeeded", JSON.stringify(end).slice(0, 2000));
      console.log(JSON.stringify({ ok: true, files: files.length, commands: names.length }));
    } finally {
      await pi.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
