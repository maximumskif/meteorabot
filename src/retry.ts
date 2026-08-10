function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  isRetryable?: (err: unknown) => boolean;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_MAX_DELAY_MS = 4000;

/**
 * Retries `fn` with exponential backoff + jitter. For read-only REST/RPC calls only —
 * never wrap a transaction send in this, since retrying a submitted-but-unconfirmed
 * transaction risks double-sending. Used so a single transient network/RPC blip during
 * signal confirmation doesn't get treated the same as "there's no real signal here"
 * (e.g. rejecting a candidate and marking cooldown just because one RPC read timed out).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const isRetryable = opts.isRetryable ?? (() => true);

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + Math.random() * 0.5);
      if (opts.label) {
        console.log(
          `[retry] ${opts.label} attempt ${attempt + 1}/${retries} failed (${(err as Error).message}), retrying in ${delay.toFixed(0)}ms`
        );
      }
      await sleep(delay);
    }
  }
}
