import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import BN from "bn.js";
import { config } from "./config";
import { getOrLoadPool, getPrice as getMeteoraPrice, quoteSwap, executeSwap as executeMeteoraSwap } from "./meteora";
import { swapStandard, swapConcentrated } from "./dex/raydiumSwap";
import { fetchPriceV3 } from "./dex/jupiterApi";
import { computeSpreadBps, type Venue } from "./strategy";
import { sendAlert } from "./alerts";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_SOL_BUFFER_LAMPORTS = 0.02 * 1e9; // covers ~2 tx fees + possible new ATA rent
/** After leg 1 lands, leg 2 only fires if this much of the original edge (net of assumed cost) still holds — otherwise abort and accept the single-leg exposure rather than chase a vanished spread. */
const LEG2_MIN_SURVIVING_BPS_FACTOR = 0.5;

export interface LiveTradeParams {
  pairKey: string;
  baseMint: string;
  baseSymbol: string;
  baseDecimals: number;
  quoteMint: string;
  quoteSymbol: string;
  quoteDecimals: number;
  meteoraPoolAddress: string;
  raydiumPoolId: string;
  raydiumPoolType: "Standard" | "Concentrated";
  buyVenue: Venue;
  sellVenue: Venue;
  meteoraTvl: number;
  raydiumTvl: number;
}

async function getTokenBalance(connection: Connection, owner: PublicKey, mint: string): Promise<BN> {
  if (mint === WSOL_MINT) {
    const lamports = await connection.getBalance(owner, "confirmed");
    return new BN(lamports);
  }
  const ata = await getAssociatedTokenAddress(new PublicKey(mint), owner);
  const account = await connection.getAccountInfo(ata);
  if (!account) return new BN(0);
  const balance = await connection.getTokenAccountBalance(ata, "confirmed");
  return new BN(balance.value.amount);
}

async function getVenuePrice(
  venue: Venue,
  connection: Connection,
  params: LiveTradeParams,
  raydiumRawPriceInCanonical: (raw: number, mintA: string) => number
): Promise<number> {
  if (venue === "meteora") {
    const pool = await getOrLoadPool(connection, params.meteoraPoolAddress);
    return (await getMeteoraPrice(pool)).price;
  }
  const { fetchOnchainPrice } = await import("./dex/raydiumOnchain");
  const raw = await fetchOnchainPrice(connection, params.raydiumPoolId, params.raydiumPoolType);
  return raydiumRawPriceInCanonical(raw, params.baseMint);
}

/**
 * Real two-leg execution. Fires leg 1 (buy venue), re-checks the other venue's price
 * before firing leg 2, and — if the edge has evaporated — aborts leg 2 rather than
 * chasing it, leaving a known, notional-capped single-leg position instead of trying
 * to cleverly unwind (unwinding is its own risk surface, not built here).
 */
export class LiveTrader {
  private dailyRealizedPnlUsd = 0;
  private dailyResetAt = new Date().toDateString();
  private dailyLossCapAlertSent = false;
  // Serializes attemptTrade calls so two pairs' trades (index.ts now checks candidates
  // concurrently) can never race past the daily-loss-cap check before either one's P&L is
  // recorded — without this, two concurrent live trades could both see "not breached yet"
  // and both fire, blowing past the cap in one burst instead of stopping cleanly.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly connection: Connection,
    private readonly wallet: Keypair,
    private readonly logPath: string,
    private readonly dailyPnlStatePath: string
  ) {
    this.loadDailyPnlState();
  }

  /** Restores today's realized P&L from disk so a restart doesn't quietly reopen the daily loss cap. Anything from a prior day is treated as stale and ignored — rolloverDayIfNeeded's usual logic. */
  private loadDailyPnlState() {
    if (!existsSync(this.dailyPnlStatePath)) return;
    try {
      const state = JSON.parse(readFileSync(this.dailyPnlStatePath, "utf8")) as { date: string; dailyRealizedPnlUsd: number };
      if (state.date === this.dailyResetAt) {
        this.dailyRealizedPnlUsd = state.dailyRealizedPnlUsd;
      }
    } catch (err) {
      console.error(`Failed to load ${this.dailyPnlStatePath}, starting today's P&L at $0: ${(err as Error).message}`);
    }
  }

  private saveDailyPnlState() {
    writeFileSync(this.dailyPnlStatePath, JSON.stringify({ date: this.dailyResetAt, dailyRealizedPnlUsd: this.dailyRealizedPnlUsd }));
  }

  private rolloverDayIfNeeded() {
    const today = new Date().toDateString();
    if (today !== this.dailyResetAt) {
      this.dailyResetAt = today;
      this.dailyRealizedPnlUsd = 0;
      this.dailyLossCapAlertSent = false;
      this.saveDailyPnlState();
    }
  }

  dailyLossCapBreached(): boolean {
    this.rolloverDayIfNeeded();
    return -this.dailyRealizedPnlUsd >= config.liveDailyLossCapUsd;
  }

  getDailyRealizedPnlUsd(): number {
    this.rolloverDayIfNeeded();
    return this.dailyRealizedPnlUsd;
  }

  private log(entry: Record<string, unknown>) {
    appendFileSync(this.logPath, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
  }

  private async executeLeg(
    venue: Venue,
    params: LiveTradeParams,
    inAmount: BN,
    direction: "quote-to-base" | "base-to-quote"
  ): Promise<string> {
    if (venue === "meteora") {
      const pool = await getOrLoadPool(this.connection, params.meteoraPoolAddress);
      const swapForY = direction === "base-to-quote";
      const quote = await quoteSwap(pool, inAmount, swapForY, config.slippageBps);
      return executeMeteoraSwap(this.connection, pool, this.wallet, inAmount, swapForY, quote);
    }

    const inputMint = direction === "quote-to-base" ? params.quoteMint : params.baseMint;
    const outputMint = direction === "quote-to-base" ? params.baseMint : params.quoteMint;
    if (params.raydiumPoolType === "Concentrated") {
      const { txId } = await swapConcentrated(this.connection, this.wallet, params.raydiumPoolId, inputMint, inAmount, config.slippageBps);
      return txId;
    }
    const { txId } = await swapStandard(
      this.connection,
      this.wallet,
      params.raydiumPoolId,
      inputMint,
      outputMint,
      inAmount,
      config.slippageBps / 10_000
    );
    return txId;
  }

  attemptTrade(params: LiveTradeParams, raydiumRawPriceInCanonical: (raw: number, mintA: string) => number): Promise<void> {
    const run = this.queue.then(() => this.executeAttempt(params, raydiumRawPriceInCanonical));
    this.queue = run.catch(() => {}); // a failed/rejected attempt must not permanently block the queue for later trades
    return run;
  }

  private async executeAttempt(params: LiveTradeParams, raydiumRawPriceInCanonical: (raw: number, mintA: string) => number): Promise<void> {
    this.rolloverDayIfNeeded();

    if (this.dailyLossCapBreached()) {
      this.log({ event: "skip", pairKey: params.pairKey, reason: "daily loss cap breached" });
      if (!this.dailyLossCapAlertSent) {
        this.dailyLossCapAlertSent = true;
        sendAlert(
          `🛑 LIVE daily loss cap breached (realized $${this.dailyRealizedPnlUsd.toFixed(2)} vs -$${config.liveDailyLossCapUsd}) — ` +
            `no new live trades until tomorrow. Paper trading continues.`
        );
      }
      return;
    }
    if (!config.livePairAllowlist.includes(params.pairKey)) {
      this.log({ event: "skip", pairKey: params.pairKey, reason: "not on LIVE_PAIR_ALLOWLIST" });
      return;
    }

    const minTvl = Math.min(params.meteoraTvl, params.raydiumTvl);
    const maxNotionalByTvl = (minTvl * config.liveMaxPositionPctOfTvl) / 100;
    if (config.liveTradeNotionalUsd > maxNotionalByTvl) {
      this.log({
        event: "skip",
        pairKey: params.pairKey,
        reason: `notional $${config.liveTradeNotionalUsd} exceeds ${config.liveMaxPositionPctOfTvl}% of min pool TVL ($${minTvl.toFixed(0)})`,
      });
      return;
    }

    const priceData = await fetchPriceV3([params.quoteMint]);
    const quoteUsdPrice = priceData[params.quoteMint]?.usdPrice;
    if (!quoteUsdPrice) {
      this.log({ event: "skip", pairKey: params.pairKey, reason: "no Jupiter USD price for quote mint" });
      return;
    }

    const quoteAmountRaw = new BN(Math.round((config.liveTradeNotionalUsd / quoteUsdPrice) * 10 ** params.quoteDecimals));

    const solBalance = await this.connection.getBalance(this.wallet.publicKey, "confirmed");
    if (solBalance < MIN_SOL_BUFFER_LAMPORTS) {
      this.log({ event: "skip", pairKey: params.pairKey, reason: `insufficient SOL buffer: ${solBalance / 1e9} SOL` });
      return;
    }
    const quoteBalance = await getTokenBalance(this.connection, this.wallet.publicKey, params.quoteMint);
    if (quoteBalance.lt(quoteAmountRaw)) {
      this.log({
        event: "skip",
        pairKey: params.pairKey,
        reason: `insufficient ${params.quoteSymbol} balance: have ${quoteBalance.toString()}, need ${quoteAmountRaw.toString()}`,
      });
      return;
    }

    // Leg 1: buy venue, spend quote -> receive base.
    const baseBalanceBeforeLeg1 = await getTokenBalance(this.connection, this.wallet.publicKey, params.baseMint);
    let leg1TxId: string;
    try {
      leg1TxId = await this.executeLeg(params.buyVenue, params, quoteAmountRaw, "quote-to-base");
    } catch (err) {
      this.log({ event: "leg1-failed", pairKey: params.pairKey, buyVenue: params.buyVenue, error: (err as Error).message });
      sendAlert(`🔴 LIVE leg 1 failed for ${params.pairKey} on ${params.buyVenue}: ${(err as Error).message}. No funds moved.`);
      return;
    }

    const baseBalanceAfterLeg1 = await getTokenBalance(this.connection, this.wallet.publicKey, params.baseMint);
    const baseReceived = baseBalanceAfterLeg1.sub(baseBalanceBeforeLeg1);
    if (baseReceived.lte(new BN(0))) {
      this.log({ event: "leg1-produced-nothing", pairKey: params.pairKey, leg1TxId });
      sendAlert(`🔴 LIVE leg 1 for ${params.pairKey} confirmed (tx ${leg1TxId}) but produced no ${params.baseSymbol} — investigate.`);
      return;
    }

    const effectiveBuyPrice =
      (Number(quoteAmountRaw.toString()) / 10 ** params.quoteDecimals) /
      (Number(baseReceived.toString()) / 10 ** params.baseDecimals);

    // Re-check the sell venue's price before committing leg 2 — this is the leg-risk gate.
    const freshSellPrice = await getVenuePrice(params.sellVenue, this.connection, params, raydiumRawPriceInCanonical);
    const survivingSpreadBps = computeSpreadBps(freshSellPrice, effectiveBuyPrice);
    const minRequiredBps = (config.assumedRoundTripCostBps * LEG2_MIN_SURVIVING_BPS_FACTOR);
    if (survivingSpreadBps < minRequiredBps) {
      this.log({
        event: "leg-risk-abort",
        pairKey: params.pairKey,
        leg1TxId,
        buyVenue: params.buyVenue,
        baseHeldUnhedged: baseReceived.toString(),
        survivingSpreadBps,
        message: `leg 1 filled but the edge evaporated before leg 2 (needed >=${minRequiredBps}bps) — leaving unhedged ${params.baseSymbol} position, not chasing it`,
      });
      sendAlert(
        `🟠 LIVE leg-risk abort on ${params.pairKey}: leg 1 filled (tx ${leg1TxId}) but edge evaporated before leg 2. ` +
          `Holding unhedged ${params.baseSymbol} (raw ${baseReceived.toString()}) — not auto-unwound, needs a look.`
      );
      return;
    }

    // Leg 2: sell venue, spend all of the base just received -> receive quote.
    const quoteBalanceBeforeLeg2 = await getTokenBalance(this.connection, this.wallet.publicKey, params.quoteMint);
    let leg2TxId: string;
    try {
      leg2TxId = await this.executeLeg(params.sellVenue, params, baseReceived, "base-to-quote");
    } catch (err) {
      this.log({
        event: "leg2-failed",
        pairKey: params.pairKey,
        leg1TxId,
        sellVenue: params.sellVenue,
        baseHeldUnhedged: baseReceived.toString(),
        error: (err as Error).message,
      });
      sendAlert(
        `🔴 LIVE leg 2 failed for ${params.pairKey} on ${params.sellVenue} after leg 1 filled (tx ${leg1TxId}): ${(err as Error).message}. ` +
          `Holding unhedged ${params.baseSymbol} (raw ${baseReceived.toString()}) — needs a look.`
      );
      return;
    }

    const quoteBalanceAfterLeg2 = await getTokenBalance(this.connection, this.wallet.publicKey, params.quoteMint);
    const quoteReceived = quoteBalanceAfterLeg2.sub(quoteBalanceBeforeLeg2);
    const pnlUsd =
      ((Number(quoteReceived.toString()) - Number(quoteAmountRaw.toString())) / 10 ** params.quoteDecimals) * quoteUsdPrice;

    this.dailyRealizedPnlUsd += pnlUsd;
    this.saveDailyPnlState();

    this.log({
      event: "fill",
      pairKey: params.pairKey,
      buyVenue: params.buyVenue,
      sellVenue: params.sellVenue,
      leg1TxId,
      leg2TxId,
      quoteSpentRaw: quoteAmountRaw.toString(),
      baseReceivedRaw: baseReceived.toString(),
      quoteReceivedRaw: quoteReceived.toString(),
      pnlUsd,
      dailyRealizedPnlUsd: this.dailyRealizedPnlUsd,
    });
    sendAlert(
      `${pnlUsd >= 0 ? "🟢" : "🟡"} LIVE fill: ${params.pairKey} buy ${params.buyVenue} → sell ${params.sellVenue}, ` +
        `pnl $${pnlUsd.toFixed(2)} (today: $${this.dailyRealizedPnlUsd.toFixed(2)})`
    );
  }
}
