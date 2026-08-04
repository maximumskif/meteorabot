import { requirePoolConfig } from "./config";
import { createConnection } from "./wallet";
import { loadPool, getPrice, quoteEntryOrExit } from "./meteora";
import { fetchCexPrice } from "./priceFeed";
import { computeSpreadBps, decideEntry, shouldExit } from "./strategy";
import { PaperTrader } from "./paperTrader";

async function main() {
  const cfg = requirePoolConfig();
  const connection = createConnection(cfg.rpcUrl);
  const pool = await loadPool(connection, cfg.poolAddress);
  const trader = new PaperTrader(cfg.tradeLogPath);

  console.log(`Pool:              ${cfg.poolAddress}`);
  console.log(`CEX reference:     ${cfg.cexBaseUrl}/${cfg.cexPair}`);
  console.log(`Entry threshold:   ${cfg.entryThresholdBps} bps + ${cfg.assumedRoundTripCostBps} bps assumed cost`);
  console.log(`Exit threshold:    ${cfg.exitThresholdBps} bps`);
  console.log(`Trade notional:    $${cfg.tradeNotionalUsd}`);
  console.log(`Paper trading only — no transactions will be sent.\n`);

  setInterval(async () => {
    try {
      const [{ price: meteoraPrice }, cexPrice] = await Promise.all([
        getPrice(pool),
        fetchCexPrice(cfg.cexBaseUrl, cfg.cexPair),
      ]);
      const spreadBps = computeSpreadBps(meteoraPrice, cexPrice);
      const position = trader.getOpenPosition();

      console.log(
        `[tick] meteora=${meteoraPrice.toFixed(4)} cex=${cexPrice.toFixed(4)} spreadBps=${spreadBps.toFixed(2)} ` +
          (position ? `openSide=${position.side}` : "flat")
      );

      if (!position) {
        const signal = decideEntry(spreadBps, cfg.entryThresholdBps, cfg.assumedRoundTripCostBps);
        if (signal === "hold") return;

        const { effectivePrice } = await quoteEntryOrExit(
          pool,
          signal,
          cfg.tradeNotionalUsd,
          meteoraPrice,
          cfg.slippageBps
        );
        trader.enter(signal, effectivePrice, spreadBps, cfg.tradeNotionalUsd);
        console.log(`[enter] side=${signal} fillPrice=${effectivePrice.toFixed(4)} spreadBps=${spreadBps.toFixed(2)}`);
        return;
      }

      const held = Date.now() - position.entryTime;
      const converged = shouldExit(spreadBps, cfg.exitThresholdBps, position.side);
      const timedOut = held >= cfg.maxHoldMs;
      if (!converged && !timedOut) return;

      const exitSide = position.side === "buy" ? "sell" : "buy";
      const { effectivePrice } = await quoteEntryOrExit(
        pool,
        exitSide,
        cfg.tradeNotionalUsd,
        meteoraPrice,
        cfg.slippageBps
      );
      const result = trader.exit(effectivePrice, spreadBps, converged ? "converged" : "max-hold");
      if (result) {
        console.log(
          `[exit] side=${result.side} reason=${result.reason} pnlBps=${result.pnlBps.toFixed(2)} pnlUsd=${result.pnlUsd.toFixed(4)} holdMs=${result.holdMs}`
        );
      }
    } catch (err) {
      console.error("[error]", err);
    }
  }, cfg.pollIntervalMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
