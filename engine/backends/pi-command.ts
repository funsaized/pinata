// The command that starts a child `pi`: PINATA_PI when set, else the same Pi the parent runs
// as (the Bun binary, or Node with the package's CLI), else `pi` on PATH.
import { basename } from "node:path";

export function piCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.PINATA_PI;
  if (configured) return /\.(c|m)?js$/.test(configured) ? ["node", configured] : [configured];
  if (process.versions.bun && /^pi(\.exe)?$/i.test(basename(process.execPath)))
    return [process.execPath];
  const script = process.argv[1] ?? "";
  if (/pi-coding-agent[\\/]dist[\\/](cli|bun[\\/]cli)\.js$/.test(script))
    return [process.execPath, script];
  return ["pi"];
}
