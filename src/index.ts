import { readFileSync } from "node:fs";
import type { Connection } from "@solana/web3.js";
import BN from "bn.js";
import { config, isLiveTradingSafeToAttempt, isUsingDefaultPublicRpc, requireWalletConfig } from "./config";
import { createConnection, loadWallet } from "./wallet";
import { fetchPoolByAddress } from "./dex/meteoraApi";
import { fetchPoolById } from "./dex/raydiumApi";
import { fetchQuote } from "./dex/jupiterApi";
import { fetchOnchainPrice, quoteRaydiumFill } from "./dex/raydiumOnchain";
import { getOrLoadPool, getPrice as getMeteoraOnchainPrice, quoteSwap } from "./meteora";
import { raydiumPriceInCanonical } from "./dex/normalize";
import { computeSpreadBps, decideEntry, isStatisticallyUnusual, type Venue } from "./strategy";
import { PaperTrader } from "./paperTrader";
import { LiveTrader } from "./liveTrader";
import { mapWithConcurrency } from "./concurrency";
import { sleep } from "./retry";
import { scanCandidates, writeCandidates } from "./scanPairs";
import { SpreadTracker } from "./spreadTracker";

/**
 * How many candidates to check concurrently per cycle, and the pause between batches.
 * Checking all candidates strictly sequentially made a full cycle take longer than
 * pollIntervalMs (2 REST calls x 41 pairs, no concurrency), which meant the old
 * setInterval-based loop started overlapping cycles against itself — same pattern
 * scanPairs.ts already avoids with its own batching.
 */
const POLL_CONCURRENCY = 5;
const POLL_BATCH_DELAY_MS = 200;

/**
 * If Jupiter's own routed price disagrees with the on-chain-confirmed mid by more than
 * this, treat the "spread" as bad pricing rather than a real opportunity. Matches the
 * scanner's own plausibility cutoff.
 */
const JUPITER_SANITY_BPS = 2000;

/**
 * Spreads wider than this survive on-chain confirmation but are still overwhelmingly
 * data/liquidity artifacts, not real edge — confirmed live: a 3-hour run paper-filled
 * Tokabu/SOL 59 times at 900-1800bps "spread" on an $86k-combined-TVL pump.fun token
 * ($3,469 of $3,803 total "profit" from one bad pair), and it slipped past the Jupiter
 * check too since Jupiter routes through the same thin pools. Matches the scanner's own
 * plausibility cutoff — reject before even attempting a fill, paper or live.
 */
const MAX_PLAUSIBLE_SPREAD_BPS = 2000;

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

/** Quotes one leg's real output against the actual venue/pool — no flat assumed slippage, real depth-aware pricing (Meteora's DLMM swapQuote, Raydium's AMM/CLMM simulation). */
async function quoteLegOut(
  connection: Connection,
  candidate: Candidate,
  venue: Venue,
  direction: "quote-to-base" | "base-to-quote",
  amountIn: BN
): Promise<BN> {
  if (venue === "meteora") {
    const pool = await getOrLoadPool(connection, candidate.meteoraPoolAddress);
    const swapForY = direction === "base-to-quote";
    const quote = await quoteSwap(pool, amountIn, swapForY, config.slippageBps);
    return quote.outAmount;
  }
  const inputMint = direction === "quote-to-base" ? candidate.quoteMint : candidate.baseMint;
  const outputMint = direction === "quote-to-base" ? candidate.baseMint : candidate.quoteMint;
  return quoteRaydiumFill(connection, candidate.raydiumPoolId, candidate.raydiumPoolType, inputMint, outputMint, amountIn);
}

function loadCandidates(): Candidate[] {
  const candidates = JSON.parse(readFileSync(config.candidatesPath, "utf-8")) as Candidate[];
  if (candidates.length === 0) {
    throw new Error(`No candidates in ${config.candidatesPath} — run "npm run scan-pairs" first.`);
  }
  return candidates;
}

/**
 * Drops any pair whose TVL fell by >= dropRejectPct on either venue since the previous
 * scan — only a runtime decision for this live loop's monitoring list, not persisted to
 * candidates.json, so a restart naturally re-includes the pair with a fresh baseline
 * rather than excluding it forever over one observed drop.
 */
function filterTvlDrops(previous: Candidate[], fresh: Candidate[], dropRejectPct: number): Candidate[] {
  if (dropRejectPct <= 0) return fresh;
  const prevByPairKey = new Map(previous.map((c) => [`${c.baseSymbol}/${c.quoteSymbol}`, c]));
  return fresh.filter((c) => {
    const pairKey = `${c.baseSymbol}/${c.quoteSymbol}`;
    const prev = prevByPairKey.get(pairKey);
    if (!prev) return true; // no prior baseline (newly discovered pair) to compare against
    const meteoraDrop = (prev.meteoraTvl - c.meteoraTvl) / prev.meteoraTvl;
    const raydiumDrop = (prev.raydiumTvl - c.raydiumTvl) / prev.raydiumTvl;
    const worstDrop = Math.max(meteoraDrop, raydiumDrop);
    if (worstDrop >= dropRejectPct) {
      console.log(
        `[tvl-drop] ${pairKey} excluded — TVL fell ${(worstDrop * 100).toFixed(0)}% since last scan ` +
          `(meteora $${prev.meteoraTvl.toFixed(0)}->$${c.meteoraTvl.toFixed(0)}, raydium $${prev.raydiumTvl.toFixed(0)}->$${c.raydiumTvl.toFixed(0)}) ` +
          `— likely a liquidity pull in progress, not trading it until a future scan confirms it's stable`
      );
      return false;
    }
    return true;
  });
}

async function checkPair(
  candidate: Candidate,
  trader: PaperTrader,
  connection: Connection,
  liveTrader: LiveTrader | null,
  spreadTracker: SpreadTracker
) {
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

  // Feed every tick's spread in, not just ones that clear a threshold, so the pair's
  // rolling stats reflect its actual normal behavior rather than a biased sample.
  spreadTracker.record(pairKey, restSpreadBps);

  if (!trader.canTrade(pairKey)) return;
  if (decideEntry(restSpreadBps, config.entryThresholdBps, config.assumedRoundTripCostBps, config.slippageBps) === "hold") return;

  const spreadStats = spreadTracker.stats(pairKey);
  if (!isStatisticallyUnusual(restSpreadBps, spreadStats, config.zScoreThreshold)) {
    trader.markCooldown(pairKey);
    console.log(
      `[reject] ${pairKey} spreadBps=${restSpreadBps.toFixed(2)} clears the flat threshold but isn't unusual for this ` +
        `pair (mean=${spreadStats!.mean.toFixed(2)} stdDev=${spreadStats!.stdDev.toFixed(2)} n=${spreadStats!.sampleCount}) — ` +
        `likely just its normal noise, not a real dislocation`
    );
    return;
  }

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

  if (Math.abs(spreadBps) > MAX_PLAUSIBLE_SPREAD_BPS) {
    trader.markCooldown(pairKey);
    console.log(
      `[reject] ${pairKey} on-chain spreadBps=${spreadBps.toFixed(2)} exceeds plausibility cutoff ` +
        `(>${MAX_PLAUSIBLE_SPREAD_BPS}bps) — almost certainly thin-liquidity/bad pricing, not real edge`
    );
    return;
  }

  // Stage 3: real depth-aware quote for the actual sized notional against the actual
  // venues, chained leg-to-leg exactly like a real trade (leg 2's input is leg 1's output).
  // A spot-price spread can look profitable while the configured notional eats itself in
  // price impact alone on a thin pool — confirmed live: a $500 fill against a pool barely
  // above MIN_POOL_TVL_USD showed 20%+ real price impact vs. the flat ~0.5% SLIPPAGE_BPS
  // this used to assume for every pool regardless of depth, and every single paper fill in
  // a 6-minute run came from two such pairs whose "spread" never actually moved. Sizing down
  // on thin pools (instead of always using the full configured notional) keeps that from
  // being a foregone conclusion on every thin pair.
  const minTvl = Math.min(candidate.meteoraTvl, candidate.raydiumTvl);
  const sizedNotionalUsd = Math.min(config.tradeNotionalUsd, (minTvl * config.tradeMaxPositionPctOfTvl) / 100);

  const quoteUsdPrice = meteoraPool.token_y.price;
  const quoteAmountRaw = new BN(Math.round((sizedNotionalUsd / quoteUsdPrice) * 10 ** candidate.quoteDecimals));

  let baseReceivedRaw: BN;
  let quoteReceivedRaw: BN;
  try {
    baseReceivedRaw = await quoteLegOut(connection, candidate, signal.buyVenue, "quote-to-base", quoteAmountRaw);
    quoteReceivedRaw = await quoteLegOut(connection, candidate, signal.sellVenue, "base-to-quote", baseReceivedRaw);
  } catch (err) {
    trader.markCooldown(pairKey);
    console.log(`[reject] ${pairKey} depth-aware quote failed: ${(err as Error).message}`);
    return;
  }

  const baseReceivedHuman = Number(baseReceivedRaw.toString()) / 10 ** candidate.baseDecimals;
  const buyFillPrice = Number(quoteAmountRaw.toString()) / 10 ** candidate.quoteDecimals / baseReceivedHuman;
  const sellFillPrice = Number(quoteReceivedRaw.toString()) / 10 ** candidate.quoteDecimals / baseReceivedHuman;

  const realGrossPnlBps = ((sellFillPrice - buyFillPrice) / buyFillPrice) * 10_000;
  const realNetPnlBps = realGrossPnlBps - config.assumedRoundTripCostBps;
  if (realNetPnlBps <= 0) {
    trader.markCooldown(pairKey);
    console.log(
      `[reject] ${pairKey} spot spreadBps=${spreadBps.toFixed(2)} but a real depth-aware $${sizedNotionalUsd.toFixed(0)} fill ` +
        `nets ${realNetPnlBps.toFixed(2)}bps after price impact — the spread wasn't really tradeable at this size`
    );
    return;
  }

  let jupiterCheckPassed = false;
  let jupiterNote: string;
  try {
    const inAmountRaw = Math.round((sizedNotionalUsd / meteoraPool.token_x.price) * 10 ** meteoraPool.token_x.decimals);
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
    jupiterCheckPassed = true;
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
    notionalUsd: sizedNotionalUsd,
    assumedRoundTripCostBps: config.assumedRoundTripCostBps,
  });

  console.log(
    `[fill] ${pairKey} buy=${result.buyVenue}@${result.buyFillPrice.toFixed(6)} sell=${result.sellVenue}@${result.sellFillPrice.toFixed(6)} ` +
      `notional=$${sizedNotionalUsd.toFixed(0)} netPnlBps=${result.netPnlBps.toFixed(2)} pnlUsd=${result.pnlUsd.toFixed(4)} (${jupiterNote})`
  );

  // Paper simulation above always runs and always logs, independent of live trading.
  // Real execution is a separate, additionally-gated action on the same confirmed signal —
  // and unlike paper (which logs a Jupiter fetch failure as a note and fills anyway, since
  // it's just data), live trading fails closed: no successful Jupiter cross-check, no trade.
  if (liveTrader && jupiterCheckPassed) {
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
  } else if (liveTrader && !jupiterCheckPassed) {
    console.log(`[live-skip] ${pairKey} signal confirmed but Jupiter cross-check didn't succeed — not risking real funds on it (${jupiterNote})`);
  }
}

async function main() {
  let candidates = loadCandidates();
  let lastScanAt = Date.now();
  const connection = createConnection(config.rpcUrl);
  const trader = new PaperTrader(config.tradeLogPath, config.tradeCooldownMs);
  const spreadTracker = new SpreadTracker();

  console.log(`Monitoring ${candidates.length} pairs from ${config.candidatesPath}`);
  console.log(
    config.scanIntervalMs > 0
      ? `Rescan interval:   every ${(config.scanIntervalMs / 60_000).toFixed(0)}min, refreshes ${config.candidatesPath} in the background`
      : `Rescan interval:   disabled (SCAN_INTERVAL_MS=0) — candidates.json only changes via a manual "npm run scan-pairs"`
  );
  console.log(`RPC:               ${config.rpcUrl} (only used to confirm signals, not per-tick)`);
  console.log(`Entry threshold:   ${config.entryThresholdBps} bps + ${config.assumedRoundTripCostBps} bps assumed cost`);
  console.log(`Z-score gate:      >=${config.zScoreThreshold} stddev from a pair's own recent mean spread (after >=10 samples)`);
  console.log(
    config.tvlDropRejectPct > 0
      ? `TVL-drop filter:   excludes a pair if either venue's TVL falls >=${(config.tvlDropRejectPct * 100).toFixed(0)}% between scans`
      : `TVL-drop filter:   disabled (TVL_DROP_REJECT_PCT=0)`
  );
  console.log(`Trade notional:    up to $${config.tradeNotionalUsd}, sized down to <=${config.tradeMaxPositionPctOfTvl}% of the smaller pool's TVL`);
  console.log(`Trade cooldown:    ${config.tradeCooldownMs}ms per pair`);
  console.log(`Paper trading:     always on, logs to ${config.tradeLogPath}\n`);

  let liveTrader: LiveTrader | null = null;
  if (isLiveTradingSafeToAttempt()) {
    const { walletSecretKey } = requireWalletConfig();
    const wallet = loadWallet(walletSecretKey);
    liveTrader = new LiveTrader(connection, wallet, config.liveTradeLogPath, config.liveDailyPnlStatePath);
    console.log("=".repeat(60));
    console.log(`LIVE TRADING ENABLED — real funds, real transactions.`);
    console.log(`Wallet:            ${wallet.publicKey.toBase58()}`);
    console.log(`Pair allowlist:    ${config.livePairAllowlist.join(", ")}`);
    console.log(`Live notional cap: $${config.liveTradeNotionalUsd} per trade`);
    console.log(`Daily loss cap:    $${config.liveDailyLossCapUsd}`);
    console.log(`Max vs pool TVL:   ${config.liveMaxPositionPctOfTvl}%`);
    console.log(`Logging to:        ${config.liveTradeLogPath}`);
    console.log(`Daily P&L state:   ${config.liveDailyPnlStatePath} (realized so far today: $${liveTrader.getDailyRealizedPnlUsd().toFixed(2)})`);
    if (isUsingDefaultPublicRpc()) {
      console.log(
        `WARNING:           RPC_URL is still the shared public endpoint (api.mainnet-beta.solana.com) — ` +
          `rate-limited and unreliable under load. Get a dedicated endpoint (Helius/Triton/QuickNode) ` +
          `before trading real size; see .env.example.`
      );
    }
    console.log("=".repeat(60) + "\n");
  } else {
    console.log(`Live trading:      off (paper only) — see .env.example for LIVE_* flags\n`);
  }

  // Self-scheduling instead of setInterval: a cycle never starts before the previous one
  // finished, so a slow cycle (rate-limited API, RPC hiccup) can't stack concurrent cycles
  // on top of itself. If a cycle runs long, the next one starts immediately rather than
  // waiting out a now-meaningless remainder.
  for (;;) {
    const cycleStart = Date.now();

    if (config.scanIntervalMs > 0 && cycleStart - lastScanAt >= config.scanIntervalMs) {
      try {
        console.log(`[scan] refreshing candidates (${((cycleStart - lastScanAt) / 60_000).toFixed(0)}min since last scan)...`);
        const fresh = await scanCandidates();
        writeCandidates(fresh); // persist the full, unfiltered scan — TVL-drop filtering is a live-loop trading decision, not a scanning one
        candidates = filterTvlDrops(candidates, fresh, config.tvlDropRejectPct);
        console.log(`[scan] refreshed ${config.candidatesPath}: ${fresh.length} pairs, monitoring ${candidates.length} after TVL-drop filter\n`);
      } catch (err) {
        // Keep trading on the existing (now slightly stale) list rather than crashing the
        // whole process over a scan failure — a transient API blip shouldn't stop paper/live
        // trading on pairs that are still fine.
        console.error(`[scan] refresh failed, keeping existing ${candidates.length} candidates:`, err);
      }
      lastScanAt = Date.now();
    }

    await mapWithConcurrency(candidates, POLL_CONCURRENCY, POLL_BATCH_DELAY_MS, async (candidate) => {
      try {
        await checkPair(candidate, trader, connection, liveTrader, spreadTracker);
      } catch (err) {
        console.error(`[error] ${candidate.baseSymbol}/${candidate.quoteSymbol}`, err);
      }
    });
    const elapsedMs = Date.now() - cycleStart;
    const waitMs = Math.max(0, config.pollIntervalMs - elapsedMs);
    console.log(`[cycle] ${elapsedMs}ms for ${candidates.length} pairs, next in ${waitMs}ms\n`);
    await sleep(waitMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
