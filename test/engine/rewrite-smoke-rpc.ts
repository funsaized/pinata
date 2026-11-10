import { spawn } from "node:child_process";

export type RpcRecord = Record<string, unknown> & { type: string };
export function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  throw new Error("Expected an RPC record");
}
export function piCommand(): string[] {
  const pi = process.env.PINATA_PI ?? "pi";
  return /\.(c|m)?js$/.test(pi) ? [process.execPath, pi] : [pi];
}
export function rpc(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(argv[0], argv.slice(1), {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const records: RpcRecord[] = [];
  const waiters = new Set<{
    match(value: RpcRecord): boolean;
    resolve(value: RpcRecord): void;
    reject(error: Error): void;
  }>();
  let buffer = "";
  let stderr = "";
  let failure: Error | undefined;
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    buffer += text;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let value: Record<string, unknown>;
      try {
        value = record(JSON.parse(line));
      } catch {
        continue;
      }
      if (typeof value.type !== "string") continue;
      const event: RpcRecord = { ...value, type: value.type };
      records.push(event);
      for (const waiter of waiters) if (waiter.match(event)) waiter.resolve(event);
    }
  });
  const exited = new Promise<void>((resolve) => {
    child.on("error", (error) => {
      failure = error;
      for (const waiter of waiters) waiter.reject(error);
    });
    child.on("close", (code, signal) => {
      failure ??= new Error(`Pi exited (${code ?? signal}): ${stderr.slice(-3000)}`);
      for (const waiter of waiters) waiter.reject(failure);
      resolve();
    });
  });
  let sequence = 0;
  return {
    records,
    send(command: Record<string, unknown>) {
      if (failure) throw failure;
      const id = `smoke-${++sequence}`;
      child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
      return id;
    },
    wait(match: (event: RpcRecord) => boolean, from = 0, timeoutMs = 30_000): Promise<RpcRecord> {
      const found = records.slice(from).find(match);
      if (found) return Promise.resolve(found);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const waiter = {
          match,
          resolve(value: RpcRecord) {
            clearTimeout(timer);
            waiters.delete(waiter);
            resolve(value);
          },
          reject(error: Error) {
            clearTimeout(timer);
            waiters.delete(waiter);
            reject(error);
          },
        };
        const timer = setTimeout(
          () =>
            waiter.reject(
              new Error(
                `Pi RPC timed out: ${stderr.slice(-3000)}; recent ${JSON.stringify(records.slice(-3)).slice(-3000)}`,
              ),
            ),
          timeoutMs,
        );
        waiters.add(waiter);
      });
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
