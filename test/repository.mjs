import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { command } from "../lib/core.mjs";

// Shared by fixture and live tests. Importing this module must not change the
// caller's environment: live runs need their real model/auth configuration.
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
  await gitIn(cwd, "init", "-q");
  await gitIn(cwd, "add", "--", "a.txt", "b.txt", "untouched.txt", ".gitignore");
  await gitIn(cwd, "commit", "-qm", "Fixture baseline");
  return { dir, cwd };
}

export async function gitIn(cwd, ...args) {
  const r = await command([
    "git",
    "-C",
    cwd,
    "-c",
    "user.name=pinata fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]);
  if (r.code) throw new Error(r.stderr);
  return r.stdout.trim();
}
