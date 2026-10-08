import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createEngine, type EngineOptions, type RunOptions } from "../../engine/core/engine.ts";
import { FakeBackend, type FakeScript } from "../../engine/backends/fake.ts";
import type { Role, TaskSpec } from "../../engine/core/types.ts";

export function spec(id: string, role: Role = "scout", extra: Partial<TaskSpec> = {}): TaskSpec {
  return { id, role, task: `Task ${id}`, acceptance: ["Evidence"], ...extra };
}

export async function tempDir(t: TestContext, prefix = "pinata-engine-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  // Retries cover files a settled run is still closing (slow CI file systems).
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return dir;
}

// An engine on the fake backend with a run directory under a temporary directory.
export async function fakeEngine(
  t: TestContext,
  scripts: Record<string, FakeScript> | ConstructorParameters<typeof FakeBackend>[0] = {},
  options: Partial<EngineOptions> = {},
) {
  const dir = await tempDir(t);
  const backend = new FakeBackend(scripts);
  const engine = createEngine({ backends: { fake: backend }, defaultBackend: "fake", ...options });
  let n = 0;
  const run = (specs: TaskSpec[], opts: RunOptions = {}) =>
    engine.run(specs, { cwd: dir, dir: join(dir, `run-${++n}`), ...opts });
  return { engine, backend, dir, run };
}
