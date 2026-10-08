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

// Shares measurements: a request reuses one that started at or after `notBefore`. At most one
// measurement per repository runs at a time; requests that arrive while it runs share the
// next one, which starts when it finishes. A burst of N settling readers costs two `git
// status` runs, not N.
export class FingerprintCache {
  private readonly states = new Map<
    string,
    {
      latest?: { at: number; value: Promise<string> };
      running?: Promise<unknown>;
      next?: Promise<string>;
    }
  >();
  private readonly measure: (root: string) => Promise<string>;
  measurements = 0;

  constructor(measure: (root: string) => Promise<string> = liveFingerprint) {
    this.measure = measure;
  }

  private start(root: string): Promise<string> {
    const state = this.states.get(root)!;
    this.measurements++;
    const entry = { at: performance.now(), value: this.measure(root) };
    state.latest = entry;
    const running = entry.value
      .catch(() => {})
      .then(() => {
        if (state.running === running) state.running = undefined;
      });
    state.running = running;
    entry.value.catch(() => {
      if (state.latest === entry) state.latest = undefined;
    });
    return entry.value;
  }

  get(root: string, notBefore: number): Promise<string> {
    let state = this.states.get(root);
    if (!state) this.states.set(root, (state = {}));
    if (state.latest && state.latest.at >= notBefore) return state.latest.value;
    if (!state.running) return this.start(root);
    if (!state.next) {
      const after = state.running;
      state.next = after.then(() => {
        state!.next = undefined;
        return this.start(root);
      });
    }
    return state.next;
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
