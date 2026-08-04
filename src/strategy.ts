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
