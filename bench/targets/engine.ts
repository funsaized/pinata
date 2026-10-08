// The engine target drives createEngine() once the in-process backend exists (E2.2).
import type { Scenario, ScenarioResult } from "../lib.ts";

export async function runEngine(
  _scenario: Scenario,
  _options: { provider: string; host: string; tokenDelayMs: number },
): Promise<ScenarioResult> {
  throw new Error("The engine target is wired in E2.2");
}
