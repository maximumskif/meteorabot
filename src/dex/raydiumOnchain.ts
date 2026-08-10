import { Raydium } from "@raydium-io/raydium-sdk-v2";
import type { Connection } from "@solana/web3.js";
import type BN from "bn.js";
import { withRetry } from "../retry";
import { computeStandardSwapQuote, simulateConcentratedSwap } from "./raydiumSwap";

let raydiumPromise: Promise<Raydium> | null = null;

function getRaydium(connection: Connection): Promise<Raydium> {
  if (!raydiumPromise) {
    raydiumPromise = withRetry(
      () =>
        Raydium.load({
          connection,
          cluster: "mainnet",
          owner: undefined,
          disableFeatureCheck: true,
          disableLoadToken: true,
        }),
      { label: "Raydium.load" }
    );
    // Don't let a failed load permanently poison future calls — retry the whole load
    // next time instead of forever returning the same rejected promise.
    raydiumPromise.catch(() => {
      raydiumPromise = null;
    });
  }
  return raydiumPromise;
}

/**
 * Fresh on-chain price (RPC read, not the cached `/pools/info` REST endpoint) for a known
 * pool. Same orientation convention as the REST API's `price` field (mintA priced in
 * mintB) since both derive from the same on-chain account — caller reorients with
 * `raydiumPriceInCanonical` using the mint ordering already known from the REST fetch.
 */
export async function fetchOnchainPrice(
  connection: Connection,
  poolId: string,
  poolType: "Standard" | "Concentrated"
): Promise<number> {
  const raydium = await getRaydium(connection);
  return withRetry(
    async () => {
      if (poolType === "Concentrated") {
        const info = await raydium.clmm.getRpcClmmPoolInfo({ poolId });
        return info.currentPrice;
      }
      const info = await raydium.liquidity.getRpcPoolInfo(poolId);
      return Number(info.poolPrice.toString());
    },
    { label: `Raydium onchain price ${poolId}` }
  );
}

/**
 * Depth-aware quote for an actual fill against this specific pool (not just the resting
 * mid-price) — no owner/signer needed, pure reads + local computation via the same
 * simulation logic used for real execution (src/dex/raydiumSwap.ts). Used to check whether
 * the configured trade notional would actually clear the modeled spread once real price
 * impact is accounted for: a flat assumed-slippage number can be wildly wrong on a thin
 * pool — confirmed live, a $500 quote against a pool barely above MIN_POOL_TVL_USD showed
 * 20%+ real price impact against a ~0.5% SLIPPAGE_BPS assumption.
 */
export async function quoteRaydiumFill(
  connection: Connection,
  poolId: string,
  poolType: "Standard" | "Concentrated",
  inputMint: string,
  outputMint: string,
  amountIn: BN
): Promise<BN> {
  const raydium = await getRaydium(connection);
  return withRetry(
    async () => {
      if (poolType === "Standard") {
        const { out } = await computeStandardSwapQuote(raydium, poolId, inputMint, outputMint, amountIn, 0);
        return out.amountOut;
      }
      const { simulation } = await simulateConcentratedSwap(connection, raydium, poolId, inputMint, amountIn);
      return simulation.amountCalculated;
    },
    { label: `Raydium depth quote ${poolId}` }
  );
}
