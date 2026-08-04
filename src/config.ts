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
  poolAddress: process.env.POOL_ADDRESS ?? "",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  dryRun: (process.env.DRY_RUN ?? "true") !== "false",

  cexBaseUrl: process.env.CEX_BASE_URL ?? "https://api.coinbase.com/v2/prices",
  cexPair: process.env.CEX_PAIR ?? "SOL-USD",

  tradeNotionalUsd: Number(process.env.TRADE_NOTIONAL_USD ?? 500),
  slippageBps: Number(process.env.SLIPPAGE_BPS ?? 50),
  entryThresholdBps: Number(process.env.ENTRY_THRESHOLD_BPS ?? 25),
  exitThresholdBps: Number(process.env.EXIT_THRESHOLD_BPS ?? 5),
  assumedRoundTripCostBps: Number(process.env.ASSUMED_ROUND_TRIP_COST_BPS ?? 15),
  maxHoldMs: Number(process.env.MAX_HOLD_MS ?? 5 * 60 * 1000),

  tradeLogPath: process.env.TRADE_LOG_PATH ?? "paper-trades.jsonl",
};

export function requirePoolConfig() {
  return {
    ...config,
    poolAddress: required("POOL_ADDRESS"),
  };
}

export function requireWalletConfig() {
  return {
    ...requirePoolConfig(),
    walletSecretKey: required("WALLET_SECRET_KEY"),
  };
}
