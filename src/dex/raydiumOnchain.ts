import { Raydium } from "@raydium-io/raydium-sdk-v2";
import type { Connection } from "@solana/web3.js";

let raydiumPromise: Promise<Raydium> | null = null;

function getRaydium(connection: Connection): Promise<Raydium> {
  if (!raydiumPromise) {
    raydiumPromise = Raydium.load({
      connection,
      cluster: "mainnet",
      owner: undefined,
      disableFeatureCheck: true,
      disableLoadToken: true,
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
  if (poolType === "Concentrated") {
    const info = await raydium.clmm.getRpcClmmPoolInfo({ poolId });
    return info.currentPrice;
  }
  const info = await raydium.liquidity.getRpcPoolInfo(poolId);
  return Number(info.poolPrice.toString());
}
