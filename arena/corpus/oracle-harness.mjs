import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Evaluation code stays outside candidate checkouts. Expectations live as literal
// test data in each task's oracle; this helper only loads modules and records results.
export async function runOracle(candidateDir, names, cases) {
  const modules = {};
  let loadError;
  try {
    if (typeof candidateDir !== "string" || candidateDir.length === 0) {
      throw new Error("Usage: node oracle.mjs <candidateDir>");
    }
    for (const name of names) {
      modules[name] = await import(pathToFileURL(resolve(candidateDir, `${name}.mjs`)).href);
    }
  } catch (error) {
    loadError = error;
  }
  const failed = [];
  for (const [name, check] of cases) {
    try {
      if (loadError) throw loadError;
      await check(modules);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failed.push(`${name}: ${detail.slice(0, 1200)}`);
    }
  }
  process.stdout.write(
    `${JSON.stringify({ passed: cases.length - failed.length, total: cases.length, failed })}\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}
