export type Side = "buy" | "sell";

export function computeSpreadBps(meteoraPrice: number, cexPrice: number): number {
  return ((meteoraPrice - cexPrice) / cexPrice) * 10_000;
}

/**
 * Meteora priced below the CEX by more than threshold+cost -> buy SOL on Meteora.
 * Meteora priced above the CEX by more than threshold+cost -> sell SOL on Meteora.
 */
export function decideEntry(
  spreadBps: number,
  entryThresholdBps: number,
  assumedRoundTripCostBps: number
): Side | "hold" {
  const requiredBps = entryThresholdBps + assumedRoundTripCostBps;
  if (spreadBps <= -requiredBps) return "buy";
  if (spreadBps >= requiredBps) return "sell";
  return "hold";
}

export function shouldExit(currentSpreadBps: number, exitThresholdBps: number, side: Side): boolean {
  return side === "buy" ? currentSpreadBps >= -exitThresholdBps : currentSpreadBps <= exitThresholdBps;
}
