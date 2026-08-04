import { readFileSync } from "node:fs";
import { config } from "./config";
import { fetchPoolByAddress } from "./dex/meteoraApi";
import { fetchPoolById } from "./dex/raydiumApi";
import { fetchQuote } from "./dex/jupiterApi";
import { raydiumPriceInCanonical } from "./dex/normalize";
import { computeSpreadBps, decideEntry, type Venue } from "./strategy";

/**
 * If Jupiter's own routed price disagrees with the Meteora/Raydium mid by more than this,
 * treat the "spread" as bad/stale pricing on a thin pool rather than a real opportunity —
 * confirmed live: MIRAI/SOL fired a trade reporting +$34 "profit" while Jupiter priced it
 * 7x away from both venues' quoted prices. Matches the scanner's own plausibility cutoff.
 */
const JUPITER_SANITY_BPS = 2000;
import { PaperTrader } from "./paperTrader";

interface Candidate {
  baseMint: string;
  baseSymbol: string;
  quoteMint: string;
  quoteSymbol: string;
  meteoraPoolAddress: string;
  raydiumPoolId: string;
}

function loadCandidates(): Candidate[] {
  const candidates = JSON.parse(readFileSync(config.candidatesPath, "utf-8")) as Candidate[];
  if (candidates.length === 0) {
    throw new Error(`No candidates in ${config.candidatesPath} — run "npm run scan-pairs" first.`);
  }
  return candidates;
}

async function checkPair(candidate: Candidate, trader: PaperTrader) {
  const pairKey = `${candidate.baseSymbol}/${candidate.quoteSymbol}`;

  const [meteoraPool, raydiumPool] = await Promise.all([
    fetchPoolByAddress(candidate.meteoraPoolAddress),
    fetchPoolById(candidate.raydiumPoolId),
  ]);
  if (!meteoraPool || !raydiumPool) {
    console.log(`[skip] ${pairKey} pool no longer found (meteora=${!!meteoraPool} raydium=${!!raydiumPool})`);
    return;
  }

  const meteoraPrice = meteoraPool.current_price;
  const raydiumPrice = raydiumPriceInCanonical(raydiumPool.price, raydiumPool.mintA.address, candidate.baseMint);
  const spreadBps = computeSpreadBps(meteoraPrice, raydiumPrice);

  console.log(
    `[tick] ${pairKey} meteora=${meteoraPrice.toFixed(6)} raydium=${raydiumPrice.toFixed(6)} spreadBps=${spreadBps.toFixed(2)}`
  );

  if (!trader.canTrade(pairKey)) return;

  const signal = decideEntry(spreadBps, config.entryThresholdBps, config.assumedRoundTripCostBps, config.slippageBps);
  if (signal === "hold") return;

  const priceOf = (venue: Venue) => (venue === "meteora" ? meteoraPrice : raydiumPrice);
  const slippage = config.slippageBps / 10_000;
  const buyFillPrice = priceOf(signal.buyVenue) * (1 + slippage);
  const sellFillPrice = priceOf(signal.sellVenue) * (1 - slippage);

  let jupiterNote: string;
  try {
    const inAmountRaw = Math.round((config.tradeNotionalUsd / meteoraPool.token_x.price) * 10 ** meteoraPool.token_x.decimals);
    const quote = await fetchQuote(candidate.baseMint, candidate.quoteMint, String(inAmountRaw));
    const inHuman = Number(quote.inAmount) / 10 ** meteoraPool.token_x.decimals;
    const outHuman = Number(quote.outAmount) / 10 ** meteoraPool.token_y.decimals;
    const jupiterPrice = outHuman / inHuman;
    const dexes = quote.routePlan.map((leg) => leg.swapInfo.label).join(",");
    jupiterNote = `jupiterPrice=${jupiterPrice.toFixed(6)} via=${dexes}`;

    const midPrice = (meteoraPrice + raydiumPrice) / 2;
    const jupiterDeviationBps = Math.abs(computeSpreadBps(jupiterPrice, midPrice));
    if (jupiterDeviationBps > JUPITER_SANITY_BPS) {
      trader.markCooldown(pairKey);
      console.log(
        `[reject] ${pairKey} spreadBps=${spreadBps.toFixed(2)} but Jupiter disagrees by ${jupiterDeviationBps.toFixed(0)}bps ` +
          `(${jupiterNote}) — likely stale/thin pricing, not a real trade`
      );
      return;
    }
  } catch (err) {
    jupiterNote = `jupiter cross-check failed: ${(err as Error).message}`;
  }

  const result = trader.fill({
    pairKey,
    buyVenue: signal.buyVenue,
    sellVenue: signal.sellVenue,
    buyFillPrice,
    sellFillPrice,
    entrySpreadBps: spreadBps,
    notionalUsd: config.tradeNotionalUsd,
    assumedRoundTripCostBps: config.assumedRoundTripCostBps,
  });

  console.log(
    `[fill] ${pairKey} buy=${result.buyVenue}@${result.buyFillPrice.toFixed(6)} sell=${result.sellVenue}@${result.sellFillPrice.toFixed(6)} ` +
      `netPnlBps=${result.netPnlBps.toFixed(2)} pnlUsd=${result.pnlUsd.toFixed(4)} (${jupiterNote})`
  );
}

async function main() {
  const candidates = loadCandidates();
  const trader = new PaperTrader(config.tradeLogPath, config.tradeCooldownMs);

  console.log(`Monitoring ${candidates.length} pairs from ${config.candidatesPath}`);
  console.log(`Entry threshold:   ${config.entryThresholdBps} bps + ${config.assumedRoundTripCostBps} bps assumed cost`);
  console.log(`Trade notional:    $${config.tradeNotionalUsd}`);
  console.log(`Trade cooldown:    ${config.tradeCooldownMs}ms per pair`);
  console.log(`Paper trading only — no transactions will be sent.\n`);

  setInterval(async () => {
    for (const candidate of candidates) {
      try {
        await checkPair(candidate, trader);
      } catch (err) {
        console.error(`[error] ${candidate.baseSymbol}/${candidate.quoteSymbol}`, err);
      }
    }
  }, config.pollIntervalMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
