import { main } from "./run.ts";
process.exitCode = await main([
  "--backend",
  "process",
  "--provider",
  "loopback",
  ...process.argv.slice(2),
]);
