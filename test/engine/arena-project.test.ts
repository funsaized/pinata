import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { tasks, projectTasks } from "../../arena/corpus/index.ts";
import { validateUnitGraph } from "../../arena/task-graph.ts";

const project = projectTasks[0]!;
const browserAvailable =
  spawnSync(process.env.ARENA_CHROMIUM_BIN ?? "chromium", ["--version"], { timeout: 10000 })
    .status === 0;

test("project is opt-in and exposes a broad, multi-level public DAG", () => {
  assert.equal(tasks.length, 3);
  assert.equal(project.id, "team-board");
  assert.equal(project.version, 2);
  assert.equal(project.units.length, 12);
  assert.equal(project.units.filter((unit) => !unit.after?.length).length, 6);
  validateUnitGraph(project.units);
  assert.throws(
    () => validateUnitGraph([{ id: "a", files: [], prompt: "", after: ["missing"] }]),
    /Invalid dependencies/,
  );
  assert.throws(
    () =>
      validateUnitGraph([
        { id: "a", files: [], prompt: "", after: ["b"] },
        { id: "b", files: [], prompt: "", after: ["a"] },
      ]),
    /Cyclic/,
  );
  assert.throws(
    () =>
      validateUnitGraph([
        { id: "a", files: [], prompt: "" },
        { id: "a", files: [], prompt: "" },
      ]),
    /Duplicate/,
  );
});

test("full-stack starter fails every independent acceptance case", () => {
  const result = spawnSync(process.execPath, [project.oracleFile, project.starterDir], {
    encoding: "utf8",
    timeout: 70000,
    env: { ...process.env, ARENA_ORACLE_TIMEOUT_MS: "60000" },
  });
  assert.equal(result.status, 1, result.stderr);
  const score = JSON.parse(result.stdout);
  assert.equal(score.total, 33);
  assert.equal(score.passed, 0);
});

test(
  "full-stack reference passes pure logic, real HTTP and fresh Chromium browser checks",
  { skip: !browserAvailable },
  () => {
    const result = spawnSync(process.execPath, [project.oracleFile, project.solutionDir], {
      encoding: "utf8",
      timeout: 70000,
      env: { ...process.env, ARENA_ORACLE_TIMEOUT_MS: "60000" },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const score = JSON.parse(result.stdout);
    assert.equal(score.total, 33);
    assert.equal(score.passed, 33);
  },
);

const mutations = [
  {
    name: "stale writes overwrite state",
    file: "store.mjs",
    pattern: /current\.revision\s*!==\s*command\.revision/,
    replacement: "false",
    module: "store",
    check: `const ticket={id:'t1',title:'Original',assignee:'',status:'todo',priority:1,revision:2};const result=await modules.store.applyCommand({nextId:2,tickets:[ticket],requests:[]},{type:'update',id:'t1',revision:1,patch:{title:'Overwrite'}});assert.equal(result.status,409);`,
  },
  {
    name: "ticket IDs sort lexically",
    file: "query.mjs",
    pattern: /Number\(a\.id\.slice\(1\)\)\s*-\s*Number\(b\.id\.slice\(1\)\)/,
    replacement: "(a.id < b.id ? -1 : 1)",
    module: "query",
    check: `const base={title:'x',assignee:'',status:'todo',priority:1,revision:1};assert.deepEqual((await modules.query.selectTickets([{...base,id:'t10'},{...base,id:'t2'}])).map(t=>t.id),['t2','t10']);`,
  },
  {
    name: "HTML title is interpolated without escaping",
    file: "html.mjs",
    pattern: /escapeHtml\(ticket\.title\)/,
    replacement: "ticket.title",
    module: "html",
    check: `const text=await modules.html.renderTicket({id:'t1',title:'<img src=x>',assignee:'',status:'todo',priority:1,revision:1});assert.ok(!text.includes('<img'));`,
  },
];
for (const mutation of mutations)
  test(`project oracle detects mutation: ${mutation.name}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "arena-project-mutation-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const candidate = join(root, "candidate");
    await cp(project.solutionDir, candidate, { recursive: true });
    const file = join(candidate, mutation.file),
      source = await readFile(file, "utf8");
    assert.match(source, mutation.pattern);
    await writeFile(file, source.replace(mutation.pattern, mutation.replacement));
    const oracle = join(root, "oracle.mjs");
    await writeFile(
      oracle,
      `import assert from 'node:assert/strict';import{runOracle}from ${JSON.stringify(pathToFileURL(resolve("arena/corpus/oracle-harness.mjs")).href)};await runOracle(process.argv[2],[${JSON.stringify(mutation.module)}],[['mutation',async modules=>{${mutation.check}}]]);`,
    );
    const result = spawnSync(process.execPath, [oracle, candidate], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, 0);
  });

test("reference HTTP persistence survives restart with idempotency cache", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arena-board-persistence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // This imports only the controller-owned reference, never an agent candidate.
  const { startServer, stopServer } =
    await import("../../arena/corpus/v2/team-board/solution/server.mjs");
  t.after(() => stopServer());
  const stateDir = join(root, "state");
  await mkdir(stateDir);
  const dataFile = join(stateDir, "data.json");
  const created = await startServer({ dataFile });
  const response = await fetch(`http://127.0.0.1:${created.port}/api/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "persist" },
    body: JSON.stringify({ title: "Saved" }),
  });
  assert.equal(response.status, 201);
  const expected = (await response.json()) as { ticket: unknown };
  await stopServer();
  const restarted = await startServer({ dataFile });
  const list = (await (await fetch(`http://127.0.0.1:${restarted.port}/api/tickets`)).json()) as {
    tickets: unknown[];
  };
  assert.deepEqual(list.tickets, [expected.ticket]);
  const retry = await fetch(`http://127.0.0.1:${restarted.port}/api/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "persist" },
    body: JSON.stringify({ title: "Saved" }),
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), expected);
  await rm(stateDir, { recursive: true, force: true });
  const failed = await fetch(`http://127.0.0.1:${restarted.port}/api/tickets/t1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: 1, patch: { title: "Lost" } }),
  });
  assert.equal(failed.status, 500);
  const unchanged = await (await fetch(`http://127.0.0.1:${restarted.port}/api/tickets/t1`)).json();
  assert.deepEqual(unchanged, expected);
  await stopServer();
  await mkdir(stateDir);
  await writeFile(dataFile, "corrupt");
  await assert.rejects(() => startServer({ dataFile }), TypeError);
});

test(
  "browser scorer accepts a status label and still rejects a broken Advance action",
  { skip: !browserAvailable },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "arena-status-label-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const candidate = join(root, "candidate");
    await cp(project.solutionDir, candidate, { recursive: true });
    const html = join(candidate, "html.mjs"),
      source = await readFile(html, "utf8");
    assert.ok(source.includes("<span data-status>"));
    await writeFile(html, source.replace("<span data-status>", "<span data-status>Status: "));
    const clientPath = join(candidate, "client.mjs");
    const clientSource = await readFile(clientPath, "utf8");
    assert.ok(clientSource.includes(".textContent,"));
    await writeFile(
      clientPath,
      clientSource.replace(".textContent,", '.textContent.replace(/^Status: /, ""),'),
    );
    const evaluate = () =>
      spawnSync(process.execPath, [project.oracleFile, candidate], {
        encoding: "utf8",
        timeout: 70000,
        env: { ...process.env, ARENA_ORACLE_TIMEOUT_MS: "60000" },
      });
    const labelled = evaluate();
    assert.equal(labelled.status, 0, labelled.stderr + labelled.stdout);
    assert.equal(JSON.parse(labelled.stdout).passed, 33);
    const client = join(candidate, "client.mjs"),
      code = await readFile(client, "utf8");
    assert.ok(code.includes('todo: "doing"'));
    await writeFile(client, code.replace('todo: "doing"', 'todo: "todo"'));
    const broken = evaluate();
    assert.equal(broken.status, 1, broken.stderr);
    assert.ok(
      JSON.parse(broken.stdout).failed.some((failure: string) =>
        failure.startsWith("browser create advance filter and delete:"),
      ),
    );
  },
);
