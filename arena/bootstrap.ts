import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const arena = dirname(fileURLToPath(import.meta.url));
// npm injects the repository's devDependency bins; prefer the user's installed CLIs.
function installed(command: string): string {
  const directories = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((path) => !path.includes("node_modules"));
  for (const directory of directories) {
    const candidate = resolve(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try next PATH entry. */
    }
  }
  throw new Error(`Cannot find installed ${command} outside npm's node_modules bins`);
}
const commands = { codex: installed("codex"), pi: installed("pi") };
mkdirSync(join(arena, "local"), { recursive: true });
for (const agent of ["codex", "pi", "pinata"] as const) {
  const executable = commands[agent === "codex" ? "codex" : "pi"];
  const path = join(arena, "local", `${agent}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        name: `${agent}-native`,
        command: process.execPath,
        args: [join(arena, "adapters/native.ts"), agent, "--executable", executable],
        model: {
          provider: "openai",
          id: "gpt-6-luna",
          version: null,
          settings: { thinking: "max", concurrency: 4 },
        },
        timeoutMs: 1200000,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Configured ${path} → ${executable}`);
}
console.log("No model calls made. Run: npm run arena:doctor, then npm run arena:local");
