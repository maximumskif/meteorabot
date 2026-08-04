import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return value;
}

export const config = {
  rpcUrl: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
  walletSecretKey: process.env.WALLET_SECRET_KEY ?? "",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  dryRun: (process.env.DRY_RUN ?? "true") !== "false",

  candidatesPath: process.env.CANDIDATES_PATH ?? "candidates.json",
  minPoolTvlUsd: Number(process.env.MIN_POOL_TVL_USD ?? 20_000),

  tradeNotionalUsd: Number(process.env.TRADE_NOTIONAL_USD ?? 500),
  slippageBps: Number(process.env.SLIPPAGE_BPS ?? 50),
  entryThresholdBps: Number(process.env.ENTRY_THRESHOLD_BPS ?? 25),
  assumedRoundTripCostBps: Number(process.env.ASSUMED_ROUND_TRIP_COST_BPS ?? 60),
  tradeCooldownMs: Number(process.env.TRADE_COOLDOWN_MS ?? 60_000),

  tradeLogPath: process.env.TRADE_LOG_PATH ?? "paper-trades.jsonl",
};

export function requireWalletConfig() {
  return {
    ...config,
    walletSecretKey: required("WALLET_SECRET_KEY"),
  };
}
