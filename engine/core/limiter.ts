// Adaptive concurrency: one limiter per provider under a global cap. A provider's limit starts
// at 8, halves on a rate-limit or overload error, and grows by one after every 10 successes.
export const RATE_LIMITED =
  /\b429\b|rate.?limit|too many requests|overloaded|over capacity|capacity exceeded|\b529\b|\b503\b|resource.?exhausted|throttl/i;

export function isRateLimit(message: string | undefined): boolean {
  return Boolean(message && RATE_LIMITED.test(message));
}

interface ProviderState {
  limit: number;
  active: number;
  successes: number;
}

export class Limiter {
  readonly cap: number;
  private readonly initial: number;
  private readonly providers = new Map<string, ProviderState>();
  private active = 0;

  constructor(options: { cap?: number; initial?: number } = {}) {
    this.cap = Math.max(1, options.cap ?? 16);
    this.initial = Math.max(1, Math.min(options.initial ?? 8, this.cap));
  }

  private state(provider: string): ProviderState {
    let s = this.providers.get(provider);
    if (!s) this.providers.set(provider, (s = { limit: this.initial, active: 0, successes: 0 }));
    return s;
  }

  limit(provider: string): number {
    return this.state(provider).limit;
  }

  tryAcquire(provider: string): boolean {
    const s = this.state(provider);
    if (this.active >= this.cap || s.active >= s.limit) return false;
    s.active++;
    this.active++;
    return true;
  }

  release(provider: string): void {
    const s = this.state(provider);
    if (s.active > 0) {
      s.active--;
      this.active--;
    }
  }

  // A 429 or overload from the provider.
  rateLimited(provider: string): void {
    const s = this.state(provider);
    s.limit = Math.max(1, Math.floor(s.limit / 2));
    s.successes = 0;
  }

  // A successful model response.
  succeeded(provider: string): void {
    const s = this.state(provider);
    if (++s.successes >= 10) {
      s.successes = 0;
      s.limit = Math.min(this.cap, s.limit + 1);
    }
  }
}
