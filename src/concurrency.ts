/** Runs `fn` over `items` with at most `concurrency` in flight at once, pausing `batchDelayMs` between batches to stay polite to rate-limited REST APIs. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  batchDelayMs: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map(fn))));
    if (i + concurrency < items.length) {
      await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
    }
  }
  return results;
}
