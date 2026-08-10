import { withRetry } from "../retry";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** 429/5xx and network failures (fetch throwing before a response) are transient; other 4xx (bad request, not found) will fail identically on retry. */
function isRetryableHttpError(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  return true;
}

/** fetch + parse JSON with retry/backoff on transient failures. */
export async function fetchJson<T>(url: string, errorLabel: string): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new HttpError(res.status, `${errorLabel} failed: ${res.status} ${res.statusText}`);
      }
      return res.json() as Promise<T>;
    },
    { isRetryable: isRetryableHttpError, label: errorLabel }
  );
}
