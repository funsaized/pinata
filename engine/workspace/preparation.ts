// Bound expensive Git/copy/install preparation independently of active model sessions.
// One gate per pipeline/host. Readers never enter it.
export class PreparationGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  readonly limit: number;

  constructor(limit = 2) {
    this.limit = limit;
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = this.waiting.indexOf(start);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(signal.reason);
        };
        this.waiting.push(start);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else this.active++;
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
