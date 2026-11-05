import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { tasks } from "../../arena/corpus/index.ts";
import type { ArenaTask } from "../../arena/types.ts";

interface Outcome {
  passed: number;
  total: number;
  failed: string[];
}

const expectedTotals: Record<string, number> = { checkout: 20, reservations: 22, incidents: 20 };

function evaluate(task: ArenaTask, candidateDir: string, passing: boolean): Outcome {
  const child = spawnSync(process.execPath, [task.oracleFile, candidateDir], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, passing ? 0 : 1, child.stderr || child.stdout);
  const outcome: Outcome = JSON.parse(child.stdout);
  assert.equal(outcome.total, expectedTotals[task.id]);
  assert.equal(outcome.passed + outcome.failed.length, outcome.total);
  assert.equal(outcome.passed === outcome.total, passing, child.stdout);
  assert.ok(outcome.failed.every((failure) => typeof failure === "string" && failure.length > 0));
  return outcome;
}

async function candidate(t: TestContext, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pinata-arena-corpus-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(source, directory, { recursive: true });
  return directory;
}

test("arena corpus exposes absolute external paths and disjoint candidate-relative units", async () => {
  assert.equal(tasks.length, 3);
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  for (const task of tasks) {
    assert.equal(task.version, 1);
    assert.ok(task.prompt.length > 1000);
    for (const path of [task.starterDir, task.solutionDir, task.oracleFile])
      assert.ok(isAbsolute(path));
    assert.ok(relative(task.starterDir, task.oracleFile).startsWith(`..${sep}`));
    const starterFiles = (await readdir(task.starterDir)).sort();
    const solutionFiles = (await readdir(task.solutionDir)).sort();
    const unitFiles = task.units.flatMap((unit) => unit.files).sort();
    assert.deepEqual(starterFiles, solutionFiles);
    assert.deepEqual(unitFiles, starterFiles);
    assert.equal(new Set(unitFiles).size, unitFiles.length);
    assert.equal(new Set(task.units.map((unit) => unit.id)).size, task.units.length);
    for (const file of unitFiles) {
      assert.equal(isAbsolute(file), false);
      assert.equal(file.includes(".."), false);
      assert.ok(file.endsWith(".mjs"));
    }
  }
});

for (const task of tasks) {
  test(`arena ${task.id}: reference passes all literal external cases`, async (t) => {
    const directory = await candidate(t, task.solutionDir);
    assert.deepEqual(
      (await readdir(directory)).sort(),
      task.units.flatMap((unit) => unit.files).sort(),
    );
    assert.equal(
      (await readdir(directory, { recursive: true })).some((file) =>
        /oracle|solution|prompt/.test(file),
      ),
      false,
    );
    evaluate(task, directory, true);
  });

  test(`arena ${task.id}: broken starter fails without oracle files in candidate`, async (t) => {
    const directory = await candidate(t, task.starterDir);
    assert.deepEqual(
      (await readdir(directory)).sort(),
      task.units.flatMap((unit) => unit.files).sort(),
    );
    assert.equal(
      (await readdir(directory, { recursive: true })).some((file) =>
        /oracle|solution|prompt/.test(file),
      ),
      false,
    );
    const outcome = evaluate(task, directory, false);
    assert.equal(outcome.passed, 0);
  });

  test(`arena ${task.id}: missing and syntactically broken modules retain denominator`, async (t) => {
    const directory = await candidate(t, task.solutionDir);
    const file = join(directory, task.units[0].files[0]);
    await writeFile(file, "export function { syntax error\n");
    assert.equal(evaluate(task, directory, false).passed, 0);
    await rm(file);
    assert.equal(evaluate(task, directory, false).passed, 0);
  });
}

const mutations = [
  {
    task: "checkout",
    name: "rounds promotion up",
    file: "promotions.mjs",
    before: "Math.floor(subtotalCents / 10)",
    after: "Math.round(subtotalCents / 10)",
    fails: "promotion rounding down",
  },
  {
    task: "checkout",
    name: "uses original subtotal for delivery",
    file: "checkout.mjs",
    before: "netCents >= 3000",
    after: "subtotalCents >= 3000",
    fails: "delivery threshold uses discounted subtotal",
  },
  {
    task: "checkout",
    name: "drops promotion at exact threshold",
    file: "promotions.mjs",
    before: "subtotalCents >= 2000",
    after: "subtotalCents > 2000",
    fails: "fixed promotion inclusive threshold",
  },
  {
    task: "reservations",
    name: "overwrites duplicate demand",
    file: "reservation.mjs",
    before: "(demand[sku] ?? 0) + line.quantity",
    after: "line.quantity",
    fails: "reservation duplicate demand can exceed stock",
  },
  {
    task: "reservations",
    name: "accepts a single shortage",
    file: "reservation.mjs",
    before: "shortages.length > 0",
    after: "shortages.length > 1",
    fails: "rejection is atomic across available and short lines",
  },
  {
    task: "reservations",
    name: "only remembers accepted order ids",
    file: "replay.mjs",
    before: "seen.add(order.id);",
    after: "// id tracked only after acceptance",
    secondBefore: "stock = reservation.stock;",
    secondAfter: "if (reservation.accepted) seen.add(order.id);\n    stock = reservation.stock;",
    fails: "replay rejected ids are also idempotent",
  },
  {
    task: "incidents",
    name: "discards message segments after a delimiter",
    file: "parse.mjs",
    before: 'messageParts.join("|")',
    after: "messageParts[0]",
    fails: "parse trims service and preserves message delimiters",
  },
  {
    task: "incidents",
    name: "includes exclusive end boundary",
    file: "aggregate.mjs",
    before: "event.timestamp >= end",
    after: "event.timestamp > end",
    fails: "half-open window boundaries",
  },
  {
    task: "incidents",
    name: "warning masks critical severity",
    file: "report.mjs",
    before: 'service.error >= 2 ? "critical" : "warning"',
    after: 'service.warn >= 3 ? "warning" : "critical"',
    fails: "critical precedence and alert ordering",
  },
];

for (const mutation of mutations) {
  test(`arena mutation ${mutation.task}: ${mutation.name}`, async (t) => {
    const task = tasks.find((entry) => entry.id === mutation.task)!;
    const directory = await candidate(t, task.solutionDir);
    const file = join(directory, mutation.file);
    let source = await readFile(file, "utf8");
    assert.equal(source.split(mutation.before).length, 2, "mutation must have exactly one target");
    source = source.replace(mutation.before, mutation.after);
    if (mutation.secondBefore && mutation.secondAfter) {
      assert.equal(source.split(mutation.secondBefore).length, 2);
      source = source.replace(mutation.secondBefore, mutation.secondAfter);
    }
    await writeFile(file, source);
    const result = evaluate(task, directory, false);
    assert.ok(result.passed > 0, "semantic controls should still pass unrelated cases");
    assert.ok(
      result.failed.some((failure) => failure.startsWith(`${mutation.fails}:`)),
      JSON.stringify(result),
    );
  });
}
