import { appendFileSync } from "node:fs";
import type { Venue } from "./strategy";

export interface TwoLegFill {
  pairKey: string;
  buyVenue: Venue;
  sellVenue: Venue;
  buyFillPrice: number;
  sellFillPrice: number;
  entrySpreadBps: number;
  notionalUsd: number;
  assumedRoundTripCostBps: number;
}

export interface TwoLegResult {
  pairKey: string;
  buyVenue: Venue;
  sellVenue: Venue;
  buyFillPrice: number;
  sellFillPrice: number;
  entrySpreadBps: number;
  grossPnlBps: number;
  netPnlBps: number;
  pnlUsd: number;
}

/**
 * Paper-simulates a two-leg arb: buy on the cheap venue and sell on the expensive venue
 * at (nearly) the same time, at each venue's current quoted price. Profit is realized
 * immediately at fill (net of assumed round-trip cost), not on later convergence — real
 * execution still has leg risk (one side fills, price moves before the other lands) that
 * this doesn't model; that's covered by the roadmap's risk-management/execution phases.
 */
export class PaperTrader {
  private lastTradeAt = new Map<string, number>();

  constructor(private readonly logPath: string, private readonly cooldownMs: number) {}

  canTrade(pairKey: string): boolean {
    const last = this.lastTradeAt.get(pairKey);
    return last === undefined || Date.now() - last >= this.cooldownMs;
  }

  /** Start the cooldown without logging a fill — used when a signal fires but is rejected. */
  markCooldown(pairKey: string): void {
    this.lastTradeAt.set(pairKey, Date.now());
  }

  fill(params: TwoLegFill): TwoLegResult {
    const grossPnlBps = ((params.sellFillPrice - params.buyFillPrice) / params.buyFillPrice) * 10_000;
    const netPnlBps = grossPnlBps - params.assumedRoundTripCostBps;
    const pnlUsd = (netPnlBps / 10_000) * params.notionalUsd;

    const result: TwoLegResult = {
      pairKey: params.pairKey,
      buyVenue: params.buyVenue,
      sellVenue: params.sellVenue,
      buyFillPrice: params.buyFillPrice,
      sellFillPrice: params.sellFillPrice,
      entrySpreadBps: params.entrySpreadBps,
      grossPnlBps,
      netPnlBps,
      pnlUsd,
    };

    this.lastTradeAt.set(params.pairKey, Date.now());
    appendFileSync(this.logPath, JSON.stringify({ time: new Date().toISOString(), event: "fill", ...result }) + "\n");
    return result;
  }
}
