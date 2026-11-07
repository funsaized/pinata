// The live checkout: readers' cwd is the repository root. No workspace is created. A
// fingerprint (HEAD plus a hash of `git status`) taken at start and at settle tells whether
// the checkout changed while the reader worked.
//
// Measurements are shared: siblings that start together reuse one `git status`, and the start
// fingerprint runs alongside the agent's first model request instead of before it.
import { createHash } from "node:crypto";
import type { Workspace } from "../core/types.ts";
import { git, gitBuffer, line } from "./git.ts";

export async function liveFingerprint(root: string, signal?: AbortSignal): Promise<string> {
  const [head, status] = await Promise.all([
    git(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true, signal }),
    gitBuffer(
      root,
      [
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
      { signal },
    ),
  ]);
  const hash = createHash("sha256").update(status.stdout).digest("hex");
  return `${line(head) || "unborn"}:${hash}`;
}

// Shares measurements: a request reuses one that started at or after `notBefore`. At most one
// measurement per repository runs at a time; requests that arrive while it runs share the
// next one, which starts when it finishes. A burst of N settling readers costs two `git
// status` runs, not N.
interface Measurement {
  at: number;
  value: Promise<string>;
  controller: AbortController;
  users: number;
  settled: boolean;
}

export class FingerprintCache {
  private readonly states = new Map<string, { latest?: Measurement; running?: Promise<void> }>();
  private readonly measure: typeof liveFingerprint;
  measurements = 0;

  constructor(measure: typeof liveFingerprint = liveFingerprint) {
    this.measure = measure;
  }

  async get(root: string, notBefore: number, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    let state = this.states.get(root);
    if (!state) this.states.set(root, (state = {}));
    let entry = state.latest;
    if (!entry || entry.at < notBefore || entry.controller.signal.aborted) {
      const controller = new AbortController();
      // Infinity lets callers share a queued measurement, which has not started yet.
      entry = { at: Infinity, controller, users: 0, settled: false, value: Promise.resolve("") };
      const current = entry;
      const start = async () => {
        controller.signal.throwIfAborted();
        current.at = performance.now();
        this.measurements++;
        return this.measure(root, controller.signal);
      };
      entry.value = state.running ? state.running.then(start) : start();
      state.latest = entry;
      const running = entry.value
        .then(
          () => {
            current.settled = true;
          },
          () => {
            current.settled = true;
            if (state.latest === current) state.latest = undefined;
          },
        )
        .then(() => {
          if (state.running === running) state.running = undefined;
        });
      state.running = running;
    }
    const current = entry;
    current.users++;
    return new Promise<string>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", abort);
        current.users--;
        // A cancelled sibling must not stop a measurement another sibling still needs.
        if (!current.users && !current.settled) current.controller.abort(signal?.reason);
      };
      const abort = () => {
        release();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      void current.value.then(
        (value) => {
          release();
          resolve(value);
        },
        (error) => {
          release();
          reject(error);
        },
      );
    });
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

  constructor(root: string, cache = fingerprints, signal?: AbortSignal) {
    this.path = root;
    this.signal = signal;
    this.started = cache.get(root, performance.now() - START_WINDOW_MS, signal);
    this.started.catch(() => {});
    this.cache = cache;
  }

  private readonly cache: FingerprintCache;
  private readonly signal?: AbortSignal;

  // A fresh fingerprint, taken now.
  fingerprint(): Promise<string> {
    return this.cache.get(this.path, performance.now(), this.signal);
  }

  // Whether the checkout changed since the reader started.
  async changed(): Promise<boolean> {
    const [before, after] = await Promise.all([this.started, this.fingerprint()]);
    return before !== after;
  }

  async dispose(): Promise<void> {}
}
