import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ROOT, command, readJson, sleep, exists } from "../lib/core.mjs";
import { init, tick, wait, cancel } from "../lib/pinata.mjs";

export async function repository(prefix = "pinata-test-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const cwd = path.join(dir, "repo");
  await fs.mkdir(cwd);
  for (const [file, data] of Object.entries({
    "a.txt": "original",
    "b.txt": "original",
    "untouched.txt": "original",
    ".gitignore": "ignored/\n",
  }))
    await fs.writeFile(path.join(cwd, file), data);
  for (const args of [
    ["init", "-q"],
    ["add", "--", "a.txt", "b.txt", "untouched.txt", ".gitignore"],
    [
      "-c",
      "user.name=pinata fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Fixture baseline",
    ],
  ]) {
    const r = await command(["git", "-C", cwd, ...args]);
    if (r.code) throw new Error(r.stderr);
  }
  return { dir, cwd };
}
export function task(id, role = "scout", scenario = {}, extra = {}) {
  return { id, role, task: JSON.stringify(scenario), acceptance: ["Fixture acceptance"], ...extra };
}
export async function fixture(t, tasks, options = {}) {
  const repo = await repository(options.prefix);
  const old = new Map();
  const vars = { TEST_HERDR_STATE: path.join(repo.dir, "herdr.json"), ...options.env };
  for (const [key, value] of Object.entries(vars)) {
    old.set(key, process.env[key]);
    process.env[key] = value;
  }
  const cfg = {
    pi: path.join(ROOT, "test/fixtures/pi.mjs"),
    herdr: path.join(ROOT, "test/fixtures/herdr.mjs"),
    session: "fixture",
    models: { default: { provider: "fixture", id: "fixture-model", thinking: "off" } },
    passEnv: Object.keys(vars),
    limits: { startupMs: 2500, taskMs: 15_000, jobMs: 120_000 },
    ...options.config,
  };
  const job = {
    cwd: repo.cwd,
    approval: "Disposable local test only",
    allowWrites: true,
    noIntegratedChecksReason: "Fixture checks are selected by each test",
    config: cfg,
    tasks,
    ...options.job,
  };
  const { run } = await init(job);
  t.after(async () => {
    try {
      await cancel(run);
    } finally {
      for (const [key, value] of old) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(repo.dir, { recursive: true, force: true });
    }
  });
  return { ...repo, run, cfg, job, manifest: () => readJson(path.join(run, "manifest.json")) };
}
export async function settled(f) {
  const s = await wait(f.run, 30_000);
  if (s.waiting) throw new Error(JSON.stringify(s));
  return s;
}
export async function untilFile(file, max = 5000) {
  const end = Date.now() + max;
  while (!(await exists(file))) {
    if (Date.now() >= end) throw new Error("Missing fixture artifact: " + file);
    await sleep(50);
  }
}
export async function started(f, name) {
  await tick(f.run);
  const file = path.join(f.run, "tasks", name, "1", "process.json");
  await untilFile(file);
  return readJson(file);
}
