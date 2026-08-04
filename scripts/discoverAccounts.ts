import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { loadPool, quoteSwap } from "../src/meteora";
import { buildStandardSwap, buildConcentratedSwap } from "../src/dex/raydiumSwap";

const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// SOL/USDC is one of the most actively-traded Meteora pools on Solana — its active bin
// was found to shift between a discovery run and the validator fork moments later,
// causing repeated "bin array not found" failures on the fork. JitoSOL/SOL is far
// quieter (a liquid-staking pair trading near a slow-moving ~1:1 ratio), so its active
// bin doesn't race us the same way — confirmed by using it for the fork test.
const METEORA_JITOSOL_SOL = "BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U";
const RAYDIUM_SOL_USDC_AMM = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
// Raydium requires a pre-existing token account for non-SOL swap inputs (unlike SOL, which
// auto-wraps) — confirmed live, an unfunded throwaway wallet fails to even BUILD a
// USDC-input tx. Use SOL-input pools for discovery so an unfunded wallet can build a real tx.
const RAYDIUM_USD1_SOL_CLMM = "AQAGYQsdU853WAKhXM79CgNdoyhrRwXvYHX6qrDyC1FS";

function printKeys(label: string, keys: PublicKey[]) {
  console.log(`\n--- ${label} (${keys.length} accounts) ---`);
  for (const k of keys) console.log(k.toBase58());
}

async function main() {
  const connection = new Connection(MAINNET_RPC, "confirmed");
  const throwaway = Keypair.generate();
  console.log("Throwaway pubkey (unfunded, build-only):", throwaway.publicKey.toBase58());

  // --- Meteora DLMM: JitoSOL/SOL (buy JitoSOL with SOL, matching forkTestSwap.ts exactly) ---
  try {
    const pool = await loadPool(connection, METEORA_JITOSOL_SOL);
    const inAmount = new BN(0.01 * 1e9);
    const quote = await quoteSwap(pool, inAmount, false, 100); // spend SOL(tokenY) to acquire JitoSOL(tokenX)
    const swapTx = await pool.swap({
      inToken: pool.tokenY.publicKey,
      outToken: pool.tokenX.publicKey,
      inAmount,
      minOutAmount: quote.minOutAmount,
      lbPair: pool.pubkey,
      user: throwaway.publicKey,
      binArraysPubkey: quote.binArraysPubkey,
    });
    const keys = (swapTx as Transaction).instructions.flatMap((ix) => ix.keys.map((k) => k.pubkey));
    printKeys("Meteora JitoSOL/SOL swap", [...new Set(keys.map((k) => k.toBase58()))].map((s) => new PublicKey(s)));
    console.log("programId (for --clone):", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  } catch (err) {
    console.error("Meteora discovery failed:", err);
  }

  // --- Raydium AMM v4: SOL/USDC ---
  try {
    const { transaction } = await buildStandardSwap(connection, throwaway, RAYDIUM_SOL_USDC_AMM, SOL_MINT, USDC_MINT, new BN(0.01 * 1e9), 0.01);
    const keys = extractKeys(transaction as unknown as Transaction | VersionedTransaction);
    printKeys("Raydium AMM v4 SOL/USDC swap (SOL input)", keys);
    console.log("programId (for --clone):", "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  } catch (err) {
    console.error("Raydium AMM discovery failed:", (err as Error).message);
  }

  // --- Raydium CLMM: USD1/SOL (SOL input, auto-wrapped) ---
  try {
    const { transaction } = await buildConcentratedSwap(connection, throwaway, RAYDIUM_USD1_SOL_CLMM, SOL_MINT, new BN(0.01 * 1e9), 100);
    const keys = extractKeys(transaction as unknown as Transaction | VersionedTransaction);
    printKeys("Raydium CLMM USD1/SOL swap (SOL input)", keys);
    console.log("programId (for --clone):", "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
  } catch (err) {
    console.error("Raydium CLMM discovery failed:", (err as Error).message);
  }
}

function extractKeys(tx: Transaction | VersionedTransaction): PublicKey[] {
  if ("instructions" in tx) {
    const keys = tx.instructions.flatMap((ix) => ix.keys.map((k) => k.pubkey));
    if (tx.feePayer) keys.push(tx.feePayer);
    return [...new Set(keys.map((k) => k.toBase58()))].map((s) => new PublicKey(s));
  }
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  return [...new Set(keys.map((k) => k.toBase58()))].map((s) => new PublicKey(s));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
