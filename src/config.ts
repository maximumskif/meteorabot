import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return value;
}

const DEFAULT_PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";

export const config = {
  rpcUrl: process.env.RPC_URL ?? DEFAULT_PUBLIC_RPC_URL,
  walletSecretKey: process.env.WALLET_SECRET_KEY ?? "",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  dryRun: (process.env.DRY_RUN ?? "true") !== "false",

  candidatesPath: process.env.CANDIDATES_PATH ?? "candidates.json",
  minPoolTvlUsd: Number(process.env.MIN_POOL_TVL_USD ?? 20_000),

  // How often the live loop re-runs the scanner to refresh candidates.json in the
  // background, in ms. 0 disables auto-rescan (candidates.json only changes via a manual
  // `npm run scan-pairs`, same as before this existed).
  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS ?? 6 * 60 * 60 * 1000),

  // If a pair's TVL on either venue drops by at least this fraction between two
  // consecutive background rescans, it's excluded from live monitoring until the next
  // scan confirms it's stable again — a fast TVL drop is a cheap proxy for a liquidity
  // pull in progress, exactly the kind of pair that produces fake-looking spread spikes.
  // Only compares against the immediately-prior in-memory scan, so it has no effect until
  // the process has run through at least one auto-rescan (see SCAN_INTERVAL_MS).
  tvlDropRejectPct: Number(process.env.TVL_DROP_REJECT_PCT ?? 0.5),

  tradeNotionalUsd: Number(process.env.TRADE_NOTIONAL_USD ?? 500),
  slippageBps: Number(process.env.SLIPPAGE_BPS ?? 50),
  entryThresholdBps: Number(process.env.ENTRY_THRESHOLD_BPS ?? 25),

  // Additional gate on top of the flat threshold above: how many standard deviations from
  // a pair's own recent mean spread the current spread must be, once there's enough history
  // (see src/spreadTracker.ts). 0 effectively disables this gate (near-any nonzero deviation
  // clears a 0 threshold).
  zScoreThreshold: Number(process.env.ZSCORE_THRESHOLD ?? 2.0),

  assumedRoundTripCostBps: Number(process.env.ASSUMED_ROUND_TRIP_COST_BPS ?? 60),
  tradeCooldownMs: Number(process.env.TRADE_COOLDOWN_MS ?? 60_000),

  tradeLogPath: process.env.TRADE_LOG_PATH ?? "paper-trades.jsonl",

  // Real-execution risk gates. ALL of these must be explicitly set before any real
  // transaction is attempted — see requireLiveTradingConfig(). No single flag flip
  // (not even DRY_RUN=false) is enough on its own.
  liveTradingEnabled: (process.env.LIVE_TRADING_ENABLED ?? "false") === "true",
  iUnderstandRealFundsAtRisk: (process.env.I_UNDERSTAND_REAL_FUNDS_AT_RISK ?? "false") === "true",
  livePairAllowlist: (process.env.LIVE_PAIR_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  liveTradeNotionalUsd: Number(process.env.LIVE_TRADE_NOTIONAL_USD ?? 0),
  liveDailyLossCapUsd: Number(process.env.LIVE_DAILY_LOSS_CAP_USD ?? 0),
  liveMaxPositionPctOfTvl: Number(process.env.LIVE_MAX_POSITION_PCT_OF_TVL ?? 1),
  liveTradeLogPath: process.env.LIVE_TRADE_LOG_PATH ?? "real-trades.jsonl",
  liveDailyPnlStatePath: process.env.LIVE_DAILY_PNL_STATE_PATH ?? "live-daily-pnl.json",

  // Optional. If set, LiveTrader posts real-money events (fills, leg failures, leg-risk
  // aborts, daily loss cap hit) to this Discord webhook URL. Alerting never blocks or
  // slows trading logic — a failed/slow webhook post is logged and swallowed, not awaited.
  alertDiscordWebhookUrl: process.env.ALERT_DISCORD_WEBHOOK_URL ?? "",
};

/** Not a hard gate (any non-default URL passes) — just flags the specific known-shared, rate-limited public endpoint so a live-trading warning can point at it. */
export function isUsingDefaultPublicRpc(): boolean {
  return config.rpcUrl === DEFAULT_PUBLIC_RPC_URL;
}

/** All must hold before any real transaction is attempted; see .env.example for what each guards against. */
export function isLiveTradingSafeToAttempt(): boolean {
  return (
    config.liveTradingEnabled &&
    config.iUnderstandRealFundsAtRisk &&
    config.livePairAllowlist.length > 0 &&
    config.liveTradeNotionalUsd > 0 &&
    config.liveDailyLossCapUsd > 0
  );
}

export function requireWalletConfig() {
  return {
    ...config,
    walletSecretKey: required("WALLET_SECRET_KEY"),
  };
}
