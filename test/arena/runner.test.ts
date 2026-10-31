import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureSource, seededFixtures } from "../../examples/arena/fixtures.ts";
import {
  boundedFile,
  loadTask,
  freshWorkspace,
  freeze,
  verify,
  hash,
} from "../../examples/arena/task.ts";
import { root, manifest, runArena, replayArena } from "../../examples/arena/runner.ts";
import { localImage, sandbox } from "../../examples/arena/sandbox.ts";
import { serveArena } from "../../examples/arena/server.ts";
const temp = async (t: any) => {
  const dir = await mkdtemp(join(tmpdir(), "pinata-arena-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const docker = process.env.ARENA_DOCKER_TEST === "1";

test(
  "freeze rejects named pipes in entry and protected files without opening them",
  { skip: process.platform === "win32", timeout: 5000 },
  async (t) => {
    const dir = await temp(t);
    const task = await loadTask(join(root, "task"));
    for (const file of [task.entry, task.prompt]) {
      const work = join(dir, file);
      await freshWorkspace(task, work);
      const path = join(work, file);
      await rm(path);
      execFileSync("mkfifo", [path]);
      await assert.rejects(boundedFile(path), /regular file/);
      await assert.rejects(freeze(task, work, join(dir, `candidate-${file}`)), /regular file/);
    }
  },
);

test("fixtures rotate fault assignments instead of assigning a branded winner", () => {
  assert.deepEqual(seededFixtures(1, "clean"), ["good", "good", "good"]);
  const assignments = [0, 1, 2].map((seed) => seededFixtures(seed, "faults"));
  for (let i = 0; i < 3; i++)
    assert.deepEqual(assignments.map((row) => row[i]).sort(), ["bad", "good", "timeout"]);
});

test("fresh task packages exclude solutions/oracles and freeze refuses protected changes or symlinks", async (t) => {
  const dir = await temp(t);
  const task = await loadTask(join(root, "task"));
  const work = join(dir, "work");
  await freshWorkspace(task, work);
  assert.deepEqual((await readdir(work)).sort(), task.publicFiles.sort());
  const starter = await readFile(join(work, "solution.mjs"), "utf8");
  assert.match(starter, /Not implemented/);
  assert.doesNotMatch(starter, /new Map|oracle/);
  await writeFile(join(work, "solution.mjs"), fixtureSource("good"));
  const artifact = await freeze(task, work, join(dir, "candidate"));
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.match(artifact.patch, /^--- a\/solution.mjs/);
  await writeFile(join(work, "requirements.md"), "tampered");
  await assert.rejects(freeze(task, work, join(dir, "bad")), /protected/);
  if (process.platform !== "win32") {
    await writeFile(
      join(work, "requirements.md"),
      await readFile(join(task.root, "public/requirements.md")),
    );
    await rm(join(work, "solution.mjs"));
    await symlink(join(task.root, "grading.mjs"), join(work, "solution.mjs"));
    await assert.rejects(freeze(task, work, join(dir, "link")), /symlink/);
  }
});

test("frozen patches apply exactly, including empty and unterminated candidates", async (t) => {
  const dir = await temp(t);
  const task = await loadTask(join(root, "task"));
  for (const [i, source] of [
    fixtureSource("good"),
    "export const settle = () => ({})",
    "",
  ].entries()) {
    const work = join(dir, `work-${i}`);
    const destination = join(dir, `destination-${i}`);
    await freshWorkspace(task, work);
    await freshWorkspace(task, destination);
    await writeFile(join(work, task.entry), source);
    const frozen = await freeze(task, work, join(dir, `candidate-${i}`));
    const patchFile = join(dir, `final-${i}.patch`);
    await writeFile(patchFile, frozen.patch);
    execFileSync(
      "git",
      ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "apply", "--check", patchFile],
      { cwd: destination },
    );
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "apply", patchFile], {
      cwd: destination,
    });
    assert.equal(await readFile(join(destination, task.entry), "utf8"), source);
  }
});

test("live calls require explicit consent before Docker access", async (t) => {
  await assert.rejects(
    runArena({ mode: "live", out: join(await temp(t), "out") }),
    /allow-provider-spend/,
  );
});

test(
  "isolated grader distinguishes a valid patch, undercount, attempted host reads and a hang",
  { skip: !docker },
  async (t) => {
    const dir = await temp(t);
    const task = await loadTask(join(root, "task"));
    const image = await localImage(manifest.verifierImage);
    for (const fixture of ["good", "bad", "mutating", "escape", "timeout"] as const) {
      const work = join(dir, fixture);
      await freshWorkspace(task, work);
      await writeFile(join(work, "solution.mjs"), fixtureSource(fixture));
      const frozen = join(dir, `${fixture}-candidate`);
      await freeze(task, work, frozen);
      const result = await verify(
        task,
        frozen,
        join(dir, `${fixture}-private`),
        image,
        7,
        fixture === "timeout" ? 700 : 5000,
        1048576,
      );
      assert.equal(result.success, fixture === "good", `${fixture}: ${JSON.stringify(result)}`);
      if (fixture === "good") assert.equal(result.passed, 81);
      if (fixture === "bad") assert(result.passed < result.total);
      if (fixture === "timeout") assert.equal(result.reason, "timeout");
    }
  },
);

test(
  "sandbox denies host paths, credentials, writes and network; kills descendants and bounds output",
  { skip: !docker },
  async (t) => {
    const dir = await temp(t);
    const work = join(dir, "work");
    const input = join(dir, "input");
    await mkdir(work);
    await mkdir(input);
    const image = await localImage(manifest.verifierImage);
    const probe = `const fs=require('fs');const net=require('net');let readOnly=false;try{fs.writeFileSync('/work/x','bad')}catch{readOnly=true}const keys=['/workspace','/home/agent','/var/run/docker.sock','/arena/grading.mjs'];const client=net.connect({host:'1.1.1.1',port:80});client.on('error',()=>{console.log(JSON.stringify({readOnly,paths:keys.map(k=>fs.existsSync(k)),credential:process.env.ARENA_TEST_SECRET??null,network:false}));});setTimeout(()=>{client.destroy();process.exit(2)},1000).unref();`;
    process.env.ARENA_TEST_SECRET = "must-not-enter-container";
    t.after(() => {
      delete process.env.ARENA_TEST_SECRET;
    });
    const result = await sandbox({
      image,
      workspace: work,
      inputDir: input,
      command: ["node", "-e", probe],
      timeoutMs: 5000,
      outputBytes: 100000,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      readOnly: true,
      paths: [false, false, false, false],
      credential: null,
      network: false,
    });
    const noisy = await sandbox({
      image,
      workspace: work,
      inputDir: input,
      command: ["node", "-e", "setInterval(()=>process.stdout.write('x'.repeat(10000)),1)"],
      timeoutMs: 5000,
      outputBytes: 1000,
    });
    assert.equal(noisy.reason, "output limit");
    const fork = await sandbox({
      image,
      workspace: work,
      inputDir: input,
      command: [
        "node",
        "-e",
        "require('child_process').spawn('node',['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000)",
      ],
      timeoutMs: 700,
      outputBytes: 10000,
    });
    assert.equal(fork.reason, "timeout");
  },
);

test(
  "end-to-end demo retains repaired receipts, replay, unknown costs, failures and cancellation",
  { skip: !docker },
  async (t) => {
    const dir = await temp(t);
    const out = join(dir, "run");
    const result = await runArena({
      out,
      mode: "simulated",
      fixtures: ["good", "bad", "unmetered"],
      stepMs: 0,
    });
    assert.deepEqual(
      result.trials.map((r) => r.quality?.success),
      [true, false, true],
    );
    assert.equal(
      result.trials[0].ledger.receipts.length,
      7,
      "parent planning/integration plus five child attempts",
    );
    assert.equal(result.trials[0].ledger.totals.costUsd, 0.11);
    assert.equal(result.trials[2].ledger.totals.costUsd, null);
    const replay = await replayArena(out);
    for (const [file, digest] of Object.entries(result.manifest.sourceFilesSha256))
      assert.equal(
        hash(await readFile(join(root, file))),
        digest,
        `generated source digest: ${file}`,
      );
    assert.equal(replay.complete, true);
    assert.deepEqual(replay.trials, result.trials);
    assert.deepEqual(replay.aggregates, result.aggregates);
    const server = await serveArena(out, 0);
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(url + "/api/state")).status, 200);
    assert.match(await (await fetch(url)).text(), /SIMULATED|CONNECTING/);
    assert.equal((await fetch(url + "/artifact/pinata-1/final.patch")).status, 200);
    assert.equal((await fetch(url + "/manifest.json")).status, 404);
    assert.equal((await fetch(url + "/api/state", { method: "POST" })).status, 405);
    const failures = await runArena({
      out: join(dir, "failures"),
      mode: "simulated",
      fixtures: ["failed", "cancelled", "timeout"],
      stepMs: 0,
      limits: { generationMs: 300 },
    });
    assert.deepEqual(
      failures.trials.map((r) => r.status),
      ["failed", "cancelled", "timeout"],
    );
    assert(
      failures.trials.every((r) => !r.patch && !r.quality && r.ledger.totals.costUsd === null),
    );
  },
);

test(
  "observed budget cancels a generation and interrupted replay stays explicitly incomplete",
  { skip: !docker },
  async (t) => {
    const dir = await temp(t);
    const out = join(dir, "budget");
    const result = await runArena({
      out,
      mode: "simulated",
      stepMs: 0,
      limits: { costUsd: 0.001 },
    });
    assert(result.trials.every((r) => r.status === "cancelled"));
    assert(result.trials.every((r) => !r.quality && r.ledger.totals.costUsd === null));
    const log = await readFile(join(out, "events.jsonl"), "utf8");
    const lines = log.trimEnd().split("\n");
    lines.pop();
    await writeFile(join(out, "events.jsonl"), lines.join("\n") + '\n{"partial":');
    assert.equal((await replayArena(out)).complete, false);
  },
);

test(
  "generic live protocol executes only inside the pinned container and flags actual child model mismatch",
  { skip: !docker },
  async (t) => {
    const dir = await temp(t);
    const source = fixtureSource("good");
    const script = `const fs=require('fs');const i=JSON.parse(fs.readFileSync('/arena/input.json','utf8'));const send=e=>console.log(JSON.stringify(e));const model={provider:'offline',id:'parent'};send({type:'session-open',id:'p',parent:null,role:'parent',model});send({type:'session-open',id:'c',parent:'p',role:'builder',model:{provider:'offline',id:'different-child'}});fs.writeFileSync('/work/solution.mjs',${JSON.stringify(source)});for(const id of ['p','c']){send({type:'usage',id:id+'/1',session:id,kind:'message',model:id==='p'?model:{provider:'offline',id:'different-child'},meters:{input:null,output:null,cacheRead:null,cacheWrite:null,totalTokens:null,turns:1,toolCalls:0,costUsd:null},pricing:{source:'unknown',reference:'Offline contract fixture; no provider used',at:'2026-10-31T00:00:00Z'}});send({type:'session-close',id,usageComplete:true});}send({type:'terminal',status:'completed',reason:'Offline adapter conformance fixture'});`;
    const result = await runArena({
      out: join(dir, "protocol"),
      mode: "live",
      allowProviderSpend: true,
      live: {
        track: "controlled-same-model",
        model: { provider: "offline", id: "parent" },
        task: join(root, "task"),
        trials: 1,
        seed: 7,
        contestants: [
          {
            id: "offline-contract-test",
            image: manifest.verifierImage,
            command: ["node", "-e", script],
            version: "offline fixture v1",
            source: "repository test fixture; not a product adapter",
            network: "none",
            secrets: [],
          },
        ],
      },
    });
    assert.equal(result.trials[0].status, "completed", result.trials[0].reason ?? "");
    assert.equal(result.trials[0].quality?.success, true);
    assert.equal(result.trials[0].comparable, false);
    assert.equal(result.trials[0].ledger.totals.costUsd, null);
    assert.equal(result.manifest.configured?.contestants[0].image?.startsWith("sha256:"), true);
  },
);

test("recorded example replay and frozen candidates match their evidence", async () => {
  const dir = join(root, "example-run");
  const replay = await replayArena(dir);
  const saved = JSON.parse(await readFile(join(dir, "results.json"), "utf8"));
  assert.equal(replay.complete, true);
  assert.deepEqual(replay.trials, saved.trials);
  assert.deepEqual(replay.aggregates, saved.aggregates);
  // Historical evidence records the source used at generation time. Updating the
  // viewer or runner must not rewrite those hashes to describe a different build.
  for (const digest of Object.values(replay.manifest.sourceFilesSha256))
    assert.match(String(digest), /^[a-f0-9]{64}$/);
  assert.equal((await loadTask(join(root, "task"))).digest, replay.manifest.task.sha256);
  for (const trial of replay.trials) {
    assert.equal(trial.mode, "simulated");
    assert.equal(trial.quality?.success, true);
    assert.equal(trial.ledger.totals.costUsd, 0.11);
    const engineEvents = (await readFile(join(dir, trial.id, "engine/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(engineEvents.findLast((e) => e.t === "run_settled").usage.cost, 0.1);
    for (const e of engineEvents.filter((e) => e.t === "agent_started")) {
      assert.equal(e.model.provider, "fixture");
      assert.equal(e.model.id, "deterministic-v1");
    }
    assert.equal(
      hash(await readFile(join(dir, trial.id, "candidate/solution.mjs"))),
      trial.patch?.sha256,
    );
  }
});

test(
  "generation can mount a public CA, rejecting private keys and malformed bundles",
  { skip: !docker },
  async (t) => {
    const dir = await temp(t);
    const image = await localImage(manifest.verifierImage);
    const work = join(dir, "work"),
      input = join(dir, "input"),
      caFile = join(dir, "ca.pem");
    await mkdir(work);
    await mkdir(input);
    await writeFile(caFile, rootCertificates[0]);
    const request = {
      image,
      workspace: work,
      inputDir: input,
      caFile,
      timeoutMs: 5000,
      outputBytes: 65536,
      command: [
        "node",
        "-e",
        "const fs=require('node:fs'); const c=process.env.NODE_EXTRA_CA_CERTS;if(c!='/run/arena-ca.pem'||!fs.readFileSync(c,'utf8').includes('BEGIN CERTIFICATE'))process.exit(1);try{fs.writeFileSync(c,'bad');process.exit(2)}catch{}",
      ],
    };
    const result = await sandbox(request);
    assert.equal(result.code, 0, result.stderr);
    await writeFile(
      caFile,
      rootCertificates[0] + "\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
    );
    await assert.rejects(sandbox(request), /Only public PEM/);
    await writeFile(caFile, "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----");
    await assert.rejects(sandbox(request));
  },
);

test("recorded real CLI mock audit reconciles every request and replays complete outcomes", async () => {
  const dir = join(root, "mock-example-run");
  const replay = await replayArena(dir);
  const audit = JSON.parse(await readFile(join(dir, "provider-audit.json"), "utf8")).audit;
  assert.equal(replay.complete, true);
  assert.equal(replay.manifest.mode, "mock");
  assert.equal(replay.trials.length, 3);
  for (const trial of replay.trials) {
    const observed = audit.find((a: any) => a.contestant === trial.contestant);
    assert(observed);
    assert.equal(trial.status, "completed");
    assert.equal(trial.quality?.success, true);
    assert.equal(trial.quality?.passed, 81);
    assert.equal(trial.ledger.complete, true);
    assert.equal(trial.ledger.sessions.length, 4);
    assert.equal(trial.ledger.totals.totalTokens, observed.providerTokens);
    assert.equal(observed.providerTokens, observed.requests * 120);
    assert.equal(observed.ledgerTokens, observed.providerTokens);
    assert.equal(trial.ledger.synthetic, true);
    assert(trial.ledger.sessions.every((s) => s.closed && s.status === "completed"));
  }
  const provenance = JSON.parse(replay.manifest.contestants[0].source);
  for (const [file, digest] of Object.entries(provenance.sources))
    assert.equal(
      hash(await readFile(join(root, "adapters", file))),
      digest,
      `adapter source drift: ${file}`,
    );
});
