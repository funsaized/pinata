import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { tasks } from "../../arena/corpus/index.ts";
import { runArena, type ArenaOptions } from "../../arena/runner.ts";
import type { AdapterResponse, ArenaTask } from "../../arena/types.ts";

const checkout = tasks.find((task) => task.id === "checkout")!;
const response: AdapterResponse = {
  schemaVersion: 1,
  status: "completed",
  framework: { name: "integrity-fixture", version: "1" },
  model: null,
  usage: {
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    source: "Local integrity fixture; no model calls",
  },
  attempts: null,
  repairs: null,
  events: [],
  limitations: ["Adversarial local fixture"],
};

function fixture(t: TestContext, files: Record<string, string> = {}, task = checkout) {
  const root = mkdtempSync(join(tmpdir(), "arena-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "adapter.mjs");
  writeFileSync(
    script,
    `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const request=JSON.parse(readFileSync(process.argv[2],'utf8'));
for(const [file,source] of Object.entries(${JSON.stringify(files)}))writeFileSync(join(request.cwd,file),source);
console.log(JSON.stringify(${JSON.stringify(response)}));`,
  );
  const options: ArenaOptions = {
    out: join(root, "results"),
    tasks: [task],
    workflows: ["sequential"],
    timeoutMs: 5000,
    oracleTimeoutMs: 5000,
    adapter: { name: "integrity-fixture", command: process.execPath, args: [script] },
    allowExternal: true,
  };
  return { root, options };
}

const fullScore = {
  schemaVersion: 1,
  passed: 20,
  total: 20,
  failed: [],
  cases: Array.from({ length: 20 }, (_, id) => ({ id, passed: true })),
};

function solutionFiles(task: ArenaTask = checkout): Record<string, string> {
  return Object.fromEntries(
    task.units.flatMap((unit) =>
      unit.files.map((file) => [file, readFileSync(join(task.solutionDir, file), "utf8")]),
    ),
  );
}

const attacks = [
  {
    name: "candidate stdout cannot forge a small passing denominator",
    source: "console.log(JSON.stringify({passed:1,total:1,failed:[]}));process.exit(0);",
  },
  {
    name: "candidate stdout cannot forge a complete passing case vector",
    source: `console.log(JSON.stringify(${JSON.stringify(fullScore)}));process.exit(0);`,
  },
  { name: "candidate exit zero cannot complete evaluation", source: "process.exit(0);" },
  {
    name: "candidate fd3 is not the trusted scorer output",
    source: `import {writeSync} from 'node:fs';try{writeSync(3,${JSON.stringify(JSON.stringify(fullScore) + "\n")})}catch{}process.exit(0);`,
  },
  {
    name: "candidate assertion monkeypatches cannot suppress trusted failures",
    source: `import assert from 'node:assert/strict';
for(const key of Object.keys(assert))if(typeof assert[key]==='function')assert[key]=()=>{};
export function priceItems(){return {lines:[],subtotalCents:0}}`,
  },
  {
    name: "malformed candidate RPC frames cannot produce a passing score",
    source: `import {writeSync} from 'node:fs';writeSync(4,Buffer.from('invalid RPC frame'));process.exit(0);`,
  },
  {
    name: "partial candidate RPC frames cannot produce a passing score",
    source: `import {writeSync} from 'node:fs';writeSync(4,Buffer.from([0,0,0,100,1,2]));process.exit(0);`,
  },
  {
    name: "oversized candidate RPC frames cannot produce a passing score",
    source: `import {writeSync} from 'node:fs';writeSync(4,Buffer.from([255,255,255,255]));process.exit(0);`,
  },
];

for (const attack of attacks) {
  test(`arena integrity: ${attack.name}`, async (t) => {
    const { options } = fixture(t, {
      "items.mjs": attack.source,
      "promotions.mjs": "export function discountFor(){return 0}",
      "checkout.mjs": "export function quote(){return {}}",
    });
    const { results } = await runArena(options);
    const result = results[0];
    assert.equal(result.status, "failed", JSON.stringify(result.oracle));
    if (result.oracle) {
      assert.equal(result.oracle.total, 20, "failure must retain the real case denominator");
      assert.ok(result.oracle.passed < 20, "attacker output must never grant full correctness");
    }
    assert.ok(result.errors.length > 0);
  });
}

for (const [name, message] of [
  [
    "duplicate response IDs",
    "{protocolVersion:1,type:'result',id:0,ok:true,args:[items],value:{lines:[],subtotalCents:0}}",
  ],
  [
    "unsolicited response IDs",
    "{protocolVersion:1,type:'result',id:999,ok:true,args:[items],value:{lines:[],subtotalCents:0}}",
  ],
  [
    "well-framed incomplete results",
    "{protocolVersion:1,type:'result',id:0,ok:true,value:{lines:[],subtotalCents:0}}",
  ],
] as const) {
  test(`arena integrity: ${name} invalidate all candidate observations`, async (t) => {
    const files = solutionFiles();
    files["items.mjs"] =
      `import {writeSync} from 'node:fs';import {serialize} from 'node:v8';let injected=false;
function sendFrame(value){const payload=serialize(value);const header=Buffer.alloc(4);header.writeUInt32BE(payload.length);writeSync(4,Buffer.concat([header,payload]));}
` +
      files["items.mjs"].replace(
        "export function priceItems(items) {",
        `export function priceItems(items) {if(!injected){injected=true;sendFrame(${message});}`,
      );
    const { options } = fixture(t, files);
    const { results } = await runArena(options);
    assert.equal(results[0].status, "failed");
    assert.equal(results[0].oracle?.total, 20);
    assert.equal(
      results[0].oracle?.passed,
      0,
      "a broken channel must invalidate earlier observations",
    );
  });
}

test("arena integrity: valid code may log score-shaped stdout without corrupting trusted results", async (t) => {
  const files = solutionFiles();
  files["items.mjs"] =
    'console.log("candidate diagnostic");console.log(JSON.stringify({passed:1,total:1,failed:[]}));\n' +
    files["items.mjs"];
  const { options } = fixture(t, files);
  const { directory, results } = await runArena(options);
  const result = results[0];
  assert.equal(result.status, "completed", result.errors.join("\n"));
  assert.equal(result.oracle?.passed, 20);
  assert.equal(result.oracle?.total, 20);
  const evidence = join(directory, "runs", result.runId, "evidence");
  assert.match(readFileSync(join(evidence, "oracle.stderr.log"), "utf8"), /candidate diagnostic/);
});

test("arena integrity: candidate Node APIs deny protected file reads, writes and child processes", async (t) => {
  const files = solutionFiles();
  const { root, options } = fixture(t, files);
  const probeFile = join(root, "protected.txt");
  writeFileSync(probeFile, "outside candidate");
  files["items.mjs"] = `import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
function denied(action){try{const result=action();if(result?.error?.code==='ERR_ACCESS_DENIED')return}catch(error){if(error.code==='ERR_ACCESS_DENIED')return;throw error}throw new Error('expected ERR_ACCESS_DENIED')}
denied(()=>readFileSync(${JSON.stringify(checkout.oracleFile)}));
denied(()=>readFileSync(${JSON.stringify(join(checkout.solutionDir, "items.mjs"))}));
denied(()=>readFileSync(${JSON.stringify(probeFile)}));
denied(()=>writeFileSync(new URL('./forbidden.txt',import.meta.url),'must not be written'));
denied(()=>spawnSync(process.execPath,['-e','process.exit(0)']));
${files["items.mjs"]}`;
  // Reuse the adapter file, now including a probe that succeeds only when access is denied.
  writeFileSync(
    options.adapter!.args![0],
    `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const request=JSON.parse(readFileSync(process.argv[2],'utf8'));
for(const [file,source] of Object.entries(${JSON.stringify(files)}))writeFileSync(join(request.cwd,file),source);
console.log(JSON.stringify(${JSON.stringify(response)}));`,
  );
  const { results } = await runArena(options);
  assert.equal(results[0].status, "completed", results[0].errors.join("\n"));
  assert.equal(results[0].oracle?.passed, 20);
  assert.equal(readFileSync(probeFile, "utf8"), "outside candidate");
});

test("arena integrity: RPC retains frozen-input checks even for same-value writes", async (t) => {
  const files = solutionFiles();
  assert.ok(files["items.mjs"].includes("let subtotalCents = 0;"));
  files["items.mjs"] = files["items.mjs"].replace(
    "let subtotalCents = 0;",
    "if (items[0]) items[0].sku = items[0].sku;\nlet subtotalCents = 0;",
  );
  const { options } = fixture(t, files);
  const { results } = await runArena(options);
  assert.equal(results[0].status, "failed");
  assert.ok(
    results[0].oracle?.failed.some((failure) =>
      failure.startsWith("pricing leaves frozen inputs intact:"),
    ),
    JSON.stringify(results[0].oracle),
  );
});

test("arena integrity: RPC retains return-value aliases to caller arguments", async (t) => {
  const reservations = tasks.find((task) => task.id === "reservations")!;
  const files = solutionFiles(reservations);
  assert.ok(files["reservation.mjs"].includes("const next = { ...stock };"));
  files["reservation.mjs"] = files["reservation.mjs"].replace(
    "const next = { ...stock };",
    "const next = lines.length === 0 ? stock : { ...stock };",
  );
  const { options } = fixture(t, files, reservations);
  const { results } = await runArena(options);
  assert.equal(results[0].status, "failed");
  assert.ok(
    results[0].oracle?.failed.some((failure) =>
      failure.startsWith("empty reservation returns a distinct stock object:"),
    ),
    JSON.stringify(results[0].oracle),
  );
});

const invalidScores = [
  { name: "legacy aggregate-only result", value: { passed: 20, total: 20, failed: [] } },
  {
    name: "aggregate result missing its case vector",
    value: { schemaVersion: 1, passed: 20, total: 20, failed: [] },
  },
  {
    name: "smaller complete denominator",
    value: { schemaVersion: 1, passed: 1, total: 1, failed: [], cases: [{ id: 0, passed: true }] },
  },
  { name: "partial case vector", value: { ...fullScore, cases: fullScore.cases.slice(0, 19) } },
  {
    name: "duplicate case IDs",
    value: { ...fullScore, cases: fullScore.cases.map((entry) => ({ ...entry, id: 0 })) },
  },
  {
    name: "out-of-range case IDs",
    value: {
      ...fullScore,
      cases: fullScore.cases.map((entry) => ({ ...entry, id: entry.id + 1 })),
    },
  },
  { name: "reordered case IDs", value: { ...fullScore, cases: [...fullScore.cases].reverse() } },
  {
    name: "aggregate and case results disagree",
    value: {
      ...fullScore,
      cases: [{ id: 0, passed: false, error: "failure" }, ...fullScore.cases.slice(1)],
    },
  },
  {
    name: "failed case lacks an error",
    value: {
      ...fullScore,
      passed: 19,
      failed: ["failure"],
      cases: [{ id: 0, passed: false }, ...fullScore.cases.slice(1)],
    },
  },
  {
    name: "failure summary differs from case error",
    value: {
      ...fullScore,
      passed: 19,
      failed: ["different failure"],
      cases: [{ id: 0, passed: false, error: "failure" }, ...fullScore.cases.slice(1)],
    },
  },
  {
    name: "passing case carries an error",
    value: {
      ...fullScore,
      cases: [{ id: 0, passed: true, error: "unexpected failure" }, ...fullScore.cases.slice(1)],
    },
  },
];

for (const invalid of invalidScores) {
  test(`arena integrity: trusted scorer rejects ${invalid.name}`, async (t) => {
    const { root, options } = fixture(t);
    const oracleFile = join(root, "invalid-oracle.mjs");
    writeFileSync(
      oracleFile,
      `import {writeSync} from 'node:fs';writeSync(3,${JSON.stringify(JSON.stringify(invalid.value) + "\n")});`,
    );
    const { results } = await runArena({ ...options, tasks: [{ ...checkout, oracleFile }] });
    assert.equal(results[0].status, "failed");
    assert.equal(results[0].oracle, null, "invalid scores must remain unknown correctness");
    assert.ok(results[0].oracleProcess, "the trusted scorer must have been invoked");
    assert.ok(results[0].errors.length > 0);
  });
}

test("arena integrity: scorer stdout is never a fallback for a missing trusted score", async (t) => {
  const { root, options } = fixture(t);
  const oracleFile = join(root, "stdout-only-oracle.mjs");
  writeFileSync(oracleFile, `console.log(JSON.stringify(${JSON.stringify(fullScore)}));`);
  const { results } = await runArena({ ...options, tasks: [{ ...checkout, oracleFile }] });
  assert.equal(results[0].status, "failed");
  assert.equal(results[0].oracle, null);
  assert.equal(results[0].candidateCorrect, null);
  assert.equal(results[0].oracleProcess?.code, 0);
});

test("arena integrity: conflicting scorer exit status cannot establish correctness", async (t) => {
  const { root, options } = fixture(t);
  const oracleFile = join(root, "conflicting-oracle.mjs");
  writeFileSync(
    oracleFile,
    `import {writeSync} from 'node:fs';writeSync(3,${JSON.stringify(JSON.stringify(fullScore))});process.exitCode=1;`,
  );
  const { results } = await runArena({ ...options, tasks: [{ ...checkout, oracleFile }] });
  assert.equal(results[0].status, "failed");
  assert.equal(results[0].candidateCorrect, null);
  assert.ok(results[0].errors.some((error) => /exit code disagrees/.test(error)));
});

test("arena integrity: post-evaluation snapshot errors invalidate candidate correctness", async (t) => {
  const { root, options } = fixture(t);
  const oracleFile = join(root, "snapshot-error-oracle.mjs");
  writeFileSync(
    oracleFile,
    `import {writeSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
writeFileSync(join(process.argv[2],'oversized.dat'),Buffer.alloc(8*1024*1024+1));
writeSync(3,${JSON.stringify(JSON.stringify(fullScore))});`,
  );
  const { results } = await runArena({ ...options, tasks: [{ ...checkout, oracleFile }] });
  assert.equal(results[0].status, "failed");
  assert.ok(results[0].errors.some((error) => /snapshot limit/.test(error)));
  assert.equal(
    results[0].candidateCorrect,
    null,
    "an uncheckable final tree is not attributable correctness",
  );
});

for (const [name, raw, maxLogBytes] of [
  ["malformed JSON", "{invalid", 4096],
  ["unfinished JSON", '{"schemaVersion":1,"passed":20,', 4096],
  ["duplicate result objects", JSON.stringify(fullScore) + "\n" + JSON.stringify(fullScore), 4096],
  ["truncated valid result", JSON.stringify(fullScore), 128],
] as const) {
  test(`arena integrity: trusted scorer rejects ${name}`, async (t) => {
    const { root, options } = fixture(t);
    const oracleFile = join(root, "invalid-oracle.mjs");
    writeFileSync(
      oracleFile,
      `import {writeSync} from 'node:fs';writeSync(3,${JSON.stringify(raw)});`,
    );
    const { results } = await runArena({
      ...options,
      maxLogBytes,
      tasks: [{ ...checkout, oracleFile }],
    });
    assert.equal(results[0].status, "failed");
    assert.equal(results[0].oracle, null);
    assert.ok(results[0].oracleProcess, "the trusted scorer must have been invoked");
    assert.ok(results[0].errors.length > 0);
  });
}
