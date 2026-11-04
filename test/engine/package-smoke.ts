// The packed package inside the real Pi: `npm pack`, install the tarball into a temporary
// prefix, and register it with `pi install <package dir>` in an isolated Pi configuration.
// Pi must discover the tools, skills and prompts, the packaged CLI must work without a
// global `pinata` command, and a faux-provider job must run through the tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { piCommand, rpc, integrationSmoke } from "./pi-smoke.ts";

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
      "agents/scout.md",
      "agents/builder.md",
      "agents/reviewer.md",
      "examples/agents/planner.md",
      "examples/agents/researcher.md",
      "examples/relay/setup.mjs",
      "examples/relay/job.json",
      "examples/relay/starter/src/parse.mjs",
      "examples/relay/verify.mjs",
      "examples/relay/expected-report.md",
    ])
      assert(files.includes(need), `missing ${need}`);
    assert.equal(files.filter((f) => f.startsWith("prompts/")).length, 5);
    assert(
      !files.some((f) =>
        /^(test|bench|node_modules|\.github)\/|(?:^|\/)node_modules\/|PLAN\.md|\.log$|\.env/.test(
          f,
        ),
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
    const relay = join(dir, "relay starter");
    const setup = spawnSync(
      process.execPath,
      [join(installed, "examples", "relay", "setup.mjs"), relay],
      { encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr || setup.stdout);
    assert.match(await readFile(join(relay, "src", "parse.mjs"), "utf8"), /Not implemented/);
    assert.equal(JSON.parse(await readFile(join(relay, "job.json"), "utf8")).tasks.length, 10);
    const unfinished = spawnSync(process.execPath, [join(relay, "verify.mjs")], {
      encoding: "utf8",
    });
    assert.equal(unfinished.status, 1);
    assert.match(unfinished.stderr, /Not implemented/);
    const repo = join(dir, "repo");
    const agent = join(dir, "agent");
    await mkdir(repo, { recursive: true });
    await mkdir(agent, { recursive: true });
    await writeFile(join(repo, "README.md"), "# Package fixture\n");
    await writeFile(
      join(agent, "pinata.json"),
      JSON.stringify({ worktreeRoot: join(dir, "worktrees") }),
    );
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
    const [piBinary, ...piArgs] = piCommand();
    const register = spawnSync(piBinary, [...piArgs, "install", installed, "--no-approve"], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(register.status, 0, register.stderr || register.stdout);
    const listed = spawnSync(piBinary, [...piArgs, "list"], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert(listed.stdout.includes(installed), listed.stdout);
    const cli = spawnSync(
      process.execPath,
      [join(installed, "bin", "pinata.mjs"), "agents", "list"],
      {
        cwd: relay,
        env,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.deepEqual(
      JSON.parse(cli.stdout)
        .map((agent: { name: string }) => agent.name)
        .sort(),
      ["builder", "reviewer", "scout"],
    );
    const pi = rpc(
      [
        ...piCommand(),
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "--no-mcp",
        "--no-themes",
        "--no-context-files",
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
        "scout",
        "builder",
        "reviewer",
        "pinata-review",
        "pinata-fix",
        "pinata",
      ])
        assert(names.includes(name), `missing command ${name}: ${names.join(", ")}`);
      for (const name of ["planner", "research", "researcher", "skill:engmgmt"])
        assert(!names.includes(name), `${name} must be opt-in`);
      const before = pi.records.length;
      const inspectId = pi.send({ type: "prompt", message: "/pinata runs" });
      const inspected = await pi.wait((r) => r.type === "response" && r.id === inspectId);
      assert.equal(inspected.success, true, JSON.stringify(inspected));
      const notice = await pi.wait(
        (r) => r.type === "extension_ui_request" && r.method === "notify",
        10_000,
        before,
      );
      assert.match(notice.message, /No pinata runs in this repository/);
      assert(!pi.records.slice(before).some((r) => r.type === "agent_start"));
      await mkdir(join(agent, "pinata", "agents"), { recursive: true });
      for (const name of ["planner", "researcher"])
        await copyFile(
          join(installed, "examples", "agents", `${name}.md`),
          join(agent, "pinata", "agents", `${name}.md`),
        );
      pi.send({ type: "prompt", message: "smoke-foreground: run pinata" });
      const end = await pi.wait(
        (r) => r.type === "tool_execution_end" && r.toolName === "pinata_run",
        120_000,
      );
      const result = end.result?.details?.result;
      assert.equal(result?.status, "succeeded", JSON.stringify(end).slice(0, 2000));
      await pi.wait((r) => r.type === "agent_settled");
      await integrationSmoke(pi);
      console.log(JSON.stringify({ ok: true, files: files.length, commands: names.length }));
    } finally {
      await pi.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
