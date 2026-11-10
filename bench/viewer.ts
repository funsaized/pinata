import { main } from "./run.ts";
process.exitCode = await main([
  "--scenario",
  "ux-8",
  "--viewer",
  "attached",
  "--mode",
  "observe",
  ...process.argv.slice(2),
]);
