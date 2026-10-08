// The live checkout: readers' cwd is the repository root. No workspace is created. A
// fingerprint (HEAD plus a hash of `git status`) taken at start and at settle tells whether
// the checkout changed while the reader worked.
//
// Measurements are shared: siblings that start together reuse one `git status`, and the start
// fingerprint runs alongside the agent's first model request instead of before it.
import { createHash } from "node:crypto";
import type { Workspace } from "../core/types.ts";
import { git, gitBuffer, line } from "./git.ts";

export async function liveFingerprint(root: string): Promise<string> {
  const [head, status] = await Promise.all([
    git(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true }),
    gitBuffer(root, [
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]),
  ]);
  const hash = createHash("sha256").update(status.stdout).digest("hex");
  return `${line(head) || "unborn"}:${hash}`;
}

// Reuses a measurement that started at or after `notBefore` (performance.now() time).
export class FingerprintCache {
  private readonly latest = new Map<string, { at: number; value: Promise<string> }>();
  private readonly measure: (root: string) => Promise<string>;

  constructor(measure: (root: string) => Promise<string> = liveFingerprint) {
    this.measure = measure;
  }

  get(root: string, notBefore: number): Promise<string> {
    const hit = this.latest.get(root);
    if (hit && hit.at >= notBefore) return hit.value;
    const entry = { at: performance.now(), value: this.measure(root) };
    entry.value.catch(() => {
      if (this.latest.get(root) === entry) this.latest.delete(root);
    });
    this.latest.set(root, entry);
    return entry.value;
  }
}

export const fingerprints = new FingerprintCache();

// Siblings starting within this window share the start fingerprint.
export const START_WINDOW_MS = 250;

export class LiveWorkspace implements Workspace {
  readonly kind = "live" as const;
  readonly path: string;
  // The fingerprint when the reader started, measured in the background.
  readonly started: Promise<string>;

  constructor(root: string, cache = fingerprints) {
    this.path = root;
    this.started = cache.get(root, performance.now() - START_WINDOW_MS);
    this.started.catch(() => {});
    this.cache = cache;
  }

  private readonly cache: FingerprintCache;

  // A fresh fingerprint, taken now.
  fingerprint(): Promise<string> {
    return this.cache.get(this.path, performance.now());
  }

  // Whether the checkout changed since the reader started.
  async changed(): Promise<boolean> {
    const [before, after] = await Promise.all([this.started, this.fingerprint()]);
    return before !== after;
  }

  async dispose(): Promise<void> {}
}
