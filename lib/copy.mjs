import * as fs from "node:fs/promises";
import { command } from "./core.mjs";

// GNU cp batches traversal and clone syscalls in one process. Node's recursive
// copier is the portable fallback. Neither path shares writable file inodes.
export async function copyDirectory(source, destination, execute) {
  if (process.platform === "linux") {
    const argv = ["cp", "-a", "--reflink=auto", "--", source, destination];
    const result = execute
      ? await execute(argv)
      : await command(argv, { timeoutMs: 120_000 }).catch(() => null);
    if (result?.code === 0) return;
    await fs.rm(destination, { recursive: true, force: true });
  }
  await fs.cp(source, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    mode: fs.constants.COPYFILE_FICLONE,
    preserveTimestamps: true,
  });
}
