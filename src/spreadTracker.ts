const WINDOW_SIZE = 30;
const MIN_SAMPLES = 10;

export interface SpreadStats {
  mean: number;
  stdDev: number;
  sampleCount: number;
}

/**
 * Tracks each pair's recent REST-spread history so an entry can be gated on whether the
 * current spread is statistically unusual FOR THAT PAIR, not just numerically large — a
 * flat bps bar means something very different on a tight, deep pair (SOL/USDC, near-zero
 * natural spread) than a thin memecoin pair that routinely swings hundreds of bps as noise
 * with no real tradeable edge. Feeding every tick's spread in (not just ones that already
 * cleared a threshold) keeps the distribution unbiased.
 */
export class SpreadTracker {
  private history = new Map<string, number[]>();

  record(pairKey: string, spreadBps: number): void {
    let samples = this.history.get(pairKey);
    if (!samples) {
      samples = [];
      this.history.set(pairKey, samples);
    }
    samples.push(spreadBps);
    if (samples.length > WINDOW_SIZE) samples.shift();
  }

  /** null until there's enough history to compute a meaningful stddev — callers should treat that as "don't block yet". */
  stats(pairKey: string): SpreadStats | null {
    const samples = this.history.get(pairKey);
    if (!samples || samples.length < MIN_SAMPLES) return null;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    return { mean, stdDev: Math.sqrt(variance), sampleCount: samples.length };
  }
}
