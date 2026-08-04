import { readFileSync } from "node:fs";
import type { Connection } from "@solana/web3.js";
import { config, isLiveTradingSafeToAttempt, requireWalletConfig } from "./config";
import { createConnection, loadWallet } from "./wallet";
import { fetchPoolByAddress } from "./dex/meteoraApi";
import { fetchPoolById } from "./dex/raydiumApi";
import { fetchQuote } from "./dex/jupiterApi";
import { fetchOnchainPrice } from "./dex/raydiumOnchain";
import { getOrLoadPool, getPrice as getMeteoraOnchainPrice } from "./meteora";
import { raydiumPriceInCanonical } from "./dex/normalize";
import { computeSpreadBps, decideEntry, type Venue } from "./strategy";
import { PaperTrader } from "./paperTrader";
import { LiveTrader } from "./liveTrader";

/**
 * If Jupiter's own routed price disagrees with the on-chain-confirmed mid by more than
 * this, treat the "spread" as bad pricing rather than a real opportunity. Matches the
 * scanner's own plausibility cutoff.
 */
const JUPITER_SANITY_BPS = 2000;

interface Candidate {
  baseMint: string;
  baseSymbol: string;
  baseDecimals: number;
  quoteMint: string;
  quoteSymbol: string;
  quoteDecimals: number;
  meteoraPoolAddress: string;
  meteoraTvl: number;
  raydiumPoolId: string;
  raydiumPoolType: "Standard" | "Concentrated";
  raydiumTvl: number;
}

function loadCandidates(): Candidate[] {
  const candidates = JSON.parse(readFileSync(config.candidatesPath, "utf-8")) as Candidate[];
  if (candidates.length === 0) {
    throw new Error(`No candidates in ${config.candidatesPath} — run "npm run scan-pairs" first.`);
  }
  return candidates;
}

async function checkPair(candidate: Candidate, trader: PaperTrader, connection: Connection, liveTrader: LiveTrader | null) {
  const pairKey = `${candidate.baseSymbol}/${candidate.quoteSymbol}`;

  // Stage 1: cheap REST poll, just to decide whether this pair is worth a closer look.
  // Both dlmm.datapi.meteora.ag and api-v3.raydium.io are indexer/cache layers that were
  // confirmed live to return bit-for-bit identical prices across 2+ minutes of polling —
  // fine for "is there possibly something here", not trustworthy enough to fire a trade on.
  const [meteoraPool, raydiumPool] = await Promise.all([
    fetchPoolByAddress(candidate.meteoraPoolAddress),
    fetchPoolById(candidate.raydiumPoolId),
  ]);
  if (!meteoraPool || !raydiumPool) {
    console.log(`[skip] ${pairKey} pool no longer found (meteora=${!!meteoraPool} raydium=${!!raydiumPool})`);
    return;
  }

  const restMeteoraPrice = meteoraPool.current_price;
  const restRaydiumPrice = raydiumPriceInCanonical(raydiumPool.price, raydiumPool.mintA.address, candidate.baseMint);
  const restSpreadBps = computeSpreadBps(restMeteoraPrice, restRaydiumPrice);

  console.log(
    `[tick] ${pairKey} meteora=${restMeteoraPrice.toFixed(6)} raydium=${restRaydiumPrice.toFixed(6)} spreadBps=${restSpreadBps.toFixed(2)}`
  );

  if (!trader.canTrade(pairKey)) return;
  if (decideEntry(restSpreadBps, config.entryThresholdBps, config.assumedRoundTripCostBps, config.slippageBps) === "hold") return;

  // Stage 2: fresh on-chain RPC read on both venues before trusting the REST-detected signal.
  let meteoraPrice: number;
  let raydiumPrice: number;
  try {
    const [meteoraPoolOnchain, raydiumRaw] = await Promise.all([
      getOrLoadPool(connection, candidate.meteoraPoolAddress).then(getMeteoraOnchainPrice),
      fetchOnchainPrice(connection, candidate.raydiumPoolId, candidate.raydiumPoolType),
    ]);
    meteoraPrice = meteoraPoolOnchain.price;
    raydiumPrice = raydiumPriceInCanonical(raydiumRaw, raydiumPool.mintA.address, candidate.baseMint);
  } catch (err) {
    trader.markCooldown(pairKey);
    console.log(`[reject] ${pairKey} on-chain confirmation failed: ${(err as Error).message}`);
    return;
  }

  const spreadBps = computeSpreadBps(meteoraPrice, raydiumPrice);
  const signal = decideEntry(spreadBps, config.entryThresholdBps, config.assumedRoundTripCostBps, config.slippageBps);
  if (signal === "hold") {
    trader.markCooldown(pairKey);
    console.log(
      `[reject] ${pairKey} REST spreadBps=${restSpreadBps.toFixed(2)} but fresh on-chain spreadBps=${spreadBps.toFixed(2)} ` +
        `no longer clears threshold — REST data was stale`
    );
    return;
  }

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
          `(${jupiterNote}) — likely bad pricing, not a real trade`
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

  // Paper simulation above always runs and always logs, independent of live trading.
  // Real execution is a separate, additionally-gated action on the same confirmed signal.
  if (liveTrader) {
    await liveTrader.attemptTrade(
      {
        pairKey,
        baseMint: candidate.baseMint,
        baseSymbol: candidate.baseSymbol,
        baseDecimals: candidate.baseDecimals,
        quoteMint: candidate.quoteMint,
        quoteSymbol: candidate.quoteSymbol,
        quoteDecimals: candidate.quoteDecimals,
        meteoraPoolAddress: candidate.meteoraPoolAddress,
        raydiumPoolId: candidate.raydiumPoolId,
        raydiumPoolType: candidate.raydiumPoolType,
        buyVenue: signal.buyVenue,
        sellVenue: signal.sellVenue,
        meteoraTvl: candidate.meteoraTvl,
        raydiumTvl: candidate.raydiumTvl,
      },
      (raw, mintA) => raydiumPriceInCanonical(raw, mintA, candidate.baseMint)
    );
  }
}

async function main() {
  const candidates = loadCandidates();
  const connection = createConnection(config.rpcUrl);
  const trader = new PaperTrader(config.tradeLogPath, config.tradeCooldownMs);

  console.log(`Monitoring ${candidates.length} pairs from ${config.candidatesPath}`);
  console.log(`RPC:               ${config.rpcUrl} (only used to confirm signals, not per-tick)`);
  console.log(`Entry threshold:   ${config.entryThresholdBps} bps + ${config.assumedRoundTripCostBps} bps assumed cost`);
  console.log(`Trade notional:    $${config.tradeNotionalUsd}`);
  console.log(`Trade cooldown:    ${config.tradeCooldownMs}ms per pair`);
  console.log(`Paper trading:     always on, logs to ${config.tradeLogPath}\n`);

  let liveTrader: LiveTrader | null = null;
  if (isLiveTradingSafeToAttempt()) {
    const { walletSecretKey } = requireWalletConfig();
    const wallet = loadWallet(walletSecretKey);
    liveTrader = new LiveTrader(connection, wallet, config.liveTradeLogPath);
    console.log("=".repeat(60));
    console.log(`LIVE TRADING ENABLED — real funds, real transactions.`);
    console.log(`Wallet:            ${wallet.publicKey.toBase58()}`);
    console.log(`Pair allowlist:    ${config.livePairAllowlist.join(", ")}`);
    console.log(`Live notional cap: $${config.liveTradeNotionalUsd} per trade`);
    console.log(`Daily loss cap:    $${config.liveDailyLossCapUsd}`);
    console.log(`Max vs pool TVL:   ${config.liveMaxPositionPctOfTvl}%`);
    console.log(`Logging to:        ${config.liveTradeLogPath}`);
    console.log("=".repeat(60) + "\n");
  } else {
    console.log(`Live trading:      off (paper only) — see .env.example for LIVE_* flags\n`);
  }

  setInterval(async () => {
    for (const candidate of candidates) {
      try {
        await checkPair(candidate, trader, connection, liveTrader);
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
