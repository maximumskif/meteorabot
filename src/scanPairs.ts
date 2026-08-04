import { writeFileSync } from "node:fs";
import { fetchTopPoolsByTvl, type MeteoraPool } from "./dex/meteoraApi";
import { fetchPoolsByMints } from "./dex/raydiumApi";
import { raydiumPriceInCanonical } from "./dex/normalize";
import { computeSpreadBps } from "./strategy";
import { config } from "./config";

const METEORA_PAGE_SIZE = 100;
const METEORA_PAGES = Number(process.env.SCAN_METEORA_PAGES ?? 5);
const RAYDIUM_CONCURRENCY = 5;
const RAYDIUM_BATCH_DELAY_MS = 200;

/**
 * Spreads wider than this are overwhelmingly data artifacts (stale/near-empty pool
 * reserves, single-sided liquidity) rather than real executable arb — confirmed by
 * running the scanner live: the top-by-|spread| results before this filter were
 * dominated by spreads in the tens-of-thousands of bps on <$50k pools, while every
 * pair with a plausible spread was a well-known, deeply liquid token.
 */
const MAX_PLAUSIBLE_SPREAD_BPS = 2000;

interface Candidate {
  baseMint: string;
  baseSymbol: string;
  quoteMint: string;
  quoteSymbol: string;
  meteoraPoolAddress: string;
  meteoraTvl: number;
  meteoraPrice: number;
  raydiumPoolId: string;
  raydiumTvl: number;
  raydiumPrice: number;
  combinedTvl: number;
  spreadBps: number;
}

function dedupeByPair(pools: MeteoraPool[]): MeteoraPool[] {
  const best = new Map<string, MeteoraPool>();
  for (const pool of pools) {
    const key = [pool.token_x.address, pool.token_y.address].sort().join("/");
    const existing = best.get(key);
    if (!existing || pool.tvl > existing.tvl) best.set(key, pool);
  }
  return [...best.values()];
}

async function mapWithConcurrency<T, R>(
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

async function main() {
  console.log(`Fetching top ${METEORA_PAGES * METEORA_PAGE_SIZE} Meteora DLMM pools by TVL...`);
  const meteoraPools = await fetchTopPoolsByTvl(METEORA_PAGE_SIZE, METEORA_PAGES);
  const pairs = dedupeByPair(meteoraPools);
  console.log(`${meteoraPools.length} pools -> ${pairs.length} unique pairs. Checking Raydium liquidity for each...`);

  const candidates = (
    await mapWithConcurrency(pairs, RAYDIUM_CONCURRENCY, RAYDIUM_BATCH_DELAY_MS, async (pool): Promise<Candidate | null> => {
      if (pool.tvl < config.minPoolTvlUsd) return null;
      try {
        const raydiumPools = await fetchPoolsByMints(pool.token_x.address, pool.token_y.address, 5);
        const raydiumPool = raydiumPools[0];
        if (!raydiumPool || raydiumPool.tvl < config.minPoolTvlUsd) return null;

        const raydiumPrice = raydiumPriceInCanonical(raydiumPool.price, raydiumPool.mintA.address, pool.token_x.address);
        const spreadBps = computeSpreadBps(pool.current_price, raydiumPrice);

        return {
          baseMint: pool.token_x.address,
          baseSymbol: pool.token_x.symbol,
          quoteMint: pool.token_y.address,
          quoteSymbol: pool.token_y.symbol,
          meteoraPoolAddress: pool.address,
          meteoraTvl: pool.tvl,
          meteoraPrice: pool.current_price,
          raydiumPoolId: raydiumPool.id,
          raydiumTvl: raydiumPool.tvl,
          raydiumPrice,
          combinedTvl: pool.tvl + raydiumPool.tvl,
          spreadBps,
        };
      } catch (err) {
        console.error(`[skip] ${pool.token_x.symbol}/${pool.token_y.symbol}: ${(err as Error).message}`);
        return null;
      }
    })
  ).filter((c): c is Candidate => c !== null);

  const implausible = candidates.filter((c) => Math.abs(c.spreadBps) > MAX_PLAUSIBLE_SPREAD_BPS);
  const plausible = candidates.filter((c) => Math.abs(c.spreadBps) <= MAX_PLAUSIBLE_SPREAD_BPS);
  if (implausible.length > 0) {
    console.log(
      `Dropped ${implausible.length} pair(s) with implausible spread (>${MAX_PLAUSIBLE_SPREAD_BPS}bps, ` +
        `almost certainly stale/thin-liquidity pricing, not real arb): ` +
        implausible.map((c) => `${c.baseSymbol}/${c.quoteSymbol}`).join(", ")
    );
  }

  plausible.sort((a, b) => b.combinedTvl - a.combinedTvl);

  writeFileSync(config.candidatesPath, JSON.stringify(plausible, null, 2));
  console.log(
    `\n${plausible.length} pairs live on both venues with >= $${config.minPoolTvlUsd.toLocaleString()} TVL each ` +
      `and a plausible spread. Wrote ${config.candidatesPath}.\n`
  );
  console.log("Top 15 by combined liquidity:");
  for (const c of plausible.slice(0, 15)) {
    console.log(
      `${c.baseSymbol}/${c.quoteSymbol}  spreadBps=${c.spreadBps.toFixed(2)}  ` +
        `meteoraTvl=$${c.meteoraTvl.toFixed(0)}  raydiumTvl=$${c.raydiumTvl.toFixed(0)}  ` +
        `meteora=${c.meteoraPoolAddress}  raydium=${c.raydiumPoolId}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
