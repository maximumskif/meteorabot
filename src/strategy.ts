import type { SpreadStats } from "./spreadTracker";

export type Venue = "meteora" | "raydium";

/** Spread of venue A's price relative to venue B's price, in bps. */
export function computeSpreadBps(priceA: number, priceB: number): number {
  return ((priceA - priceB) / priceB) * 10_000;
}

export interface ArbSignal {
  buyVenue: Venue;
  sellVenue: Venue;
}

/**
 * Meteora priced below Raydium by more than threshold+cost -> buy on Meteora, sell on Raydium.
 * Meteora priced above Raydium by more than threshold+cost -> buy on Raydium, sell on Meteora.
 * (spreadBps = computeSpreadBps(meteoraPrice, raydiumPrice))
 *
 * requiredBps must include 2x slippageBps, not just assumedRoundTripCostBps: the paper
 * fill haircuts BOTH legs by slippageBps (buy leg up, sell leg down), so a spread that
 * only clears entryThresholdBps + assumedRoundTripCostBps is still a guaranteed loss
 * once that haircut is applied — confirmed live (jellyjelly/SOL: 118.84bps spread cleared
 * an 85bps gate that didn't account for slippage, netted -41.85bps after fill).
 */
export function decideEntry(
  spreadBps: number,
  entryThresholdBps: number,
  assumedRoundTripCostBps: number,
  slippageBps: number
): ArbSignal | "hold" {
  const requiredBps = entryThresholdBps + assumedRoundTripCostBps + 2 * slippageBps;
  if (spreadBps <= -requiredBps) return { buyVenue: "meteora", sellVenue: "raydium" };
  if (spreadBps >= requiredBps) return { buyVenue: "raydium", sellVenue: "meteora" };
  return "hold";
}

/**
 * Additional confirmation on top of decideEntry's flat economic floor, not a replacement
 * for it — a spread still must clear entryThresholdBps + costs to ever be profitable no
 * matter how statistically unusual it is. This exists to stop burning Stage 2/3 RPC calls
 * chasing spreads that comfortably clear the flat bar but are actually just that specific
 * pair's normal noise (a volatile thin pool can sit above a flat bps bar routinely without
 * ever representing a real, persistent dislocation).
 *
 * Returns true (doesn't block) when there isn't yet enough spread history for this pair —
 * a freshly-scanned candidate shouldn't be stuck unable to trade until it accumulates
 * MIN_SAMPLES ticks worth of history.
 */
export function isStatisticallyUnusual(spreadBps: number, stats: SpreadStats | null, zScoreThreshold: number): boolean {
  if (!stats) return true;
  if (stats.stdDev === 0) return spreadBps !== stats.mean;
  return Math.abs(spreadBps - stats.mean) / stats.stdDev >= zScoreThreshold;
}
