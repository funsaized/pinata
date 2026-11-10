import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { surfaceReplySchema, type CoreState } from "../../engine/contracts/index.ts";
import { captureSource, EvidenceStore } from "../../arena/evidence.ts";
import { piCommand, record, rpc, type RpcRecord } from "./rewrite-smoke-rpc.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const incidentPhases = ["creation", "followup", "settlement", "recovery"] as const;
export type IncidentPhase = (typeof incidentPhases)[number];

export async function runPricesIncident(options: {
  directory: string;
  phase: IncidentPhase;
  command: string[];
}): Promise<{
  phase: IncidentPhase;
  run: string;
  beforeRevision: number;
  acceptedRevision: number;
  records: number;
}> {
  await mkdir(options.directory, { recursive: true });
  const directory = await realpath(options.directory);
  const workspace = join(directory, "workspace");
  const agentDir = join(directory, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(workspace, "README.md"), "Scripted historical dependency regression.\n");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ quietStartup: true, retry: { enabled: false } }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PINATA_INCIDENT_DIRECTORY: directory,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  delete env.PINATA_AGENT;
  const argv = [
    ...options.command,
    "--mode",
    "rpc",
    "--session",
    join(directory, "parent.jsonl"),
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--extension",
    join(root, "test/engine/fixtures/rewrite-incident-provider.ts"),
    "--provider",
    "rewrite-incident",
    "--model",
    "script",
    "--thinking",
    "off",
  ];
  const history: RpcRecord[] = [];
  let pi = rpc(argv, { cwd: workspace, env });
  const call = async (operation: string, toolName: string) => {
    const from = pi.records.length;
    pi.send({ type: "prompt", message: `incident:${operation}` });
    const event = await pi.wait(
      (value) => value.type === "tool_execution_end" && value.toolName === toolName,
      from,
    );
    const reply = surfaceReplySchema.parse(record(event.result).details);
    assert.equal(reply.status, "ok", JSON.stringify(reply));
    await pi.wait((value) => value.type === "agent_settled", from);
    assert(reply.status === "ok");
    return reply.response;
  };
  const status = async (): Promise<CoreState> => {
    const response = await call("status", "pinata_status");
    assert(response.method === "query" && response.result.kind === "status");
    return response.result.state;
  };
  const wait = async () => {
    const response = await call("wait", "pinata_wait");
    assert(response.method === "wait");
    assert(
      response.result.results.every(
        (result) => result.execution.phase === "ended" && result.execution.reason === "completed",
      ),
    );
  };
  try {
    if (options.phase !== "creation") await writeFile(join(directory, "release-workers"), "go\n");
    const created = await call("create", "pinata_run");
    assert(
      created.method === "execute" && created.result.status === "accepted",
      JSON.stringify(created),
    );
    const run = created.result.assignments[0].run;
    if (options.phase !== "creation") await wait();
    if (options.phase === "followup") {
      await rm(join(directory, "release-workers"));
      const followed = await call("followup", "pinata_run");
      assert(followed.method === "execute" && followed.result.status === "accepted");
      assert.deepEqual(followed.result.assignments, [{ run, worker: "prices", assignment: 2 }]);
    }
    if (options.phase === "recovery") {
      await pi.close();
      history.push(...pi.records);
      pi = rpc(argv, { cwd: workspace, env });
    }
    const before = await status();
    assert.equal(before.run, run);
    assert.deepEqual(Object.keys(before.workers).sort(), ["integration", "prices", "promos"]);
    if (options.phase === "creation" || options.phase === "followup")
      assert(
        Object.values(before.assignments).some(
          (assignment) => assignment.execution.phase !== "ended",
        ),
      );
    else
      assert(
        Object.values(before.assignments).every(
          (assignment) => assignment.execution.phase === "ended",
        ),
      );
    const audit = await call("audit", "pinata_run");
    assert(audit.method === "execute" && audit.result.status === "accepted", JSON.stringify(audit));
    const accepted = await status();
    const assignment = Object.values(accepted.assignments).find(
      (value) => value.ref.worker === "audit",
    );
    assert(assignment);
    assert.deepEqual(assignment.after, [
      { run, worker: "prices", assignment: options.phase === "followup" ? 2 : 1 },
      { run, worker: "promos", assignment: 1 },
      { run, worker: "integration", assignment: 1 },
    ]);
    const historical = JSON.parse(
      await readFile(new URL("./fixtures/rewrite-prices-incident.json", import.meta.url), "utf8"),
    );
    assert.equal(assignment.task, historical.invocation.args.tasks[0].task);
    assert.deepEqual(assignment.context, ["Review base: HEAD. Treat this as review context."]);
    assert.equal(accepted.workers.audit.access, "read");
    assert.equal(accepted.workers.audit.workspace, "shared");
    await writeFile(
      join(directory, "accepted-graph.json"),
      JSON.stringify({ before, receipt: audit.result, after: accepted }, null, 2),
    );
    await writeFile(join(directory, "release-workers"), "go\n");
    await wait();
    const result = {
      phase: options.phase,
      run,
      beforeRevision: before.revision,
      acceptedRevision: audit.result.revision,
      records: history.length + pi.records.length,
    };
    await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await writeFile(join(directory, "release-workers"), "go\n");
    await pi.close();
    history.push(...pi.records);
    await writeFile(
      join(directory, "rpc.jsonl"),
      history.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const directory = resolve(process.argv[2] ?? "bench/results/rewrite-prices-incident");
  await mkdir(directory, { recursive: false });
  const command = piCommand();
  const version = spawnSync(command[0], [...command.slice(1), "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  const store = new EvidenceStore(join(directory, "artifacts"));
  const source = await captureSource(root, store);
  const fixtureFiles = [
    "rewrite-prices-incident.ts",
    "rewrite-smoke-rpc.ts",
    "fixtures/rewrite-incident-provider.ts",
    "fixtures/rewrite-prices-incident.json",
  ];
  const fixtures = await Promise.all(
    fixtureFiles.map(async (path) => ({
      path,
      artifact: await store.put(await readFile(join(root, "test/engine", path))),
    })),
  );
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        historicalStatus: "unexplained",
        provider: "scripted",
        command,
        version: version.stdout.trim(),
        harnessNode: process.version,
        platform: process.platform,
        source,
        fixtures,
      },
      null,
      2,
    ),
  );
  const results = [];
  for (const phase of incidentPhases)
    results.push(await runPricesIncident({ directory: join(directory, phase), phase, command }));
  await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify({
      ok: true,
      directory,
      phases: results.length,
      historicalStatus: "unexplained",
    }),
  );
}
