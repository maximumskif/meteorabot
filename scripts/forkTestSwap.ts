import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import { loadPool, quoteSwap, executeSwap as executeMeteoraSwap } from "../src/meteora";
import { swapStandard, swapConcentrated } from "../src/dex/raydiumSwap";

const RPC_URL = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8899";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const METEORA_JITOSOL_SOL = "BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U";
const RAYDIUM_SOL_USDC_AMM = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const RAYDIUM_USD1_SOL_CLMM = "AQAGYQsdU853WAKhXM79CgNdoyhrRwXvYHX6qrDyC1FS";

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = Keypair.generate();
  console.log(`Test wallet: ${wallet.publicKey.toBase58()}`);

  console.log("Airdropping 10 SOL (fake, local fork only)...");
  const airdropSig = await connection.requestAirdrop(wallet.publicKey, 10 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(airdropSig, "confirmed");
  const solBalance = await connection.getBalance(wallet.publicKey, "confirmed");
  console.log(`Wallet SOL balance: ${solBalance / LAMPORTS_PER_SOL}`);

  let failures = 0;

  // --- Test 1: Meteora DLMM — buy JitoSOL with 0.01 SOL ---
  console.log("\n=== Test 1: Meteora DLMM (buy JitoSOL with SOL) ===");
  try {
    const pool = await loadPool(connection, METEORA_JITOSOL_SOL);
    const inAmount = new BN(0.01 * LAMPORTS_PER_SOL);
    const swapForY = false; // spending tokenY(SOL) to acquire tokenX(JitoSOL)
    const quote = await quoteSwap(pool, inAmount, swapForY, 100);
    const before = await connection.getBalance(wallet.publicKey, "confirmed");
    const sig = await executeMeteoraSwap(connection, pool, wallet, inAmount, swapForY, quote);
    const after = await connection.getBalance(wallet.publicKey, "confirmed");
    console.log(`OK. txId=${sig} SOL balance ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL}`);
    if (after >= before) throw new Error("SOL balance did not decrease as expected");
  } catch (err) {
    failures++;
    console.error("FAILED:", err);
  }

  // --- Test 2: Raydium AMM v4 — sell 0.01 SOL for USDC ---
  console.log("\n=== Test 2: Raydium AMM v4 (sell SOL for USDC) ===");
  try {
    const before = await connection.getBalance(wallet.publicKey, "confirmed");
    const { txId } = await swapStandard(connection, wallet, RAYDIUM_SOL_USDC_AMM, SOL_MINT, USDC_MINT, new BN(0.01 * LAMPORTS_PER_SOL), 0.01);
    const after = await connection.getBalance(wallet.publicKey, "confirmed");
    console.log(`OK. txId=${txId} SOL balance ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL}`);
    if (after >= before) throw new Error("SOL balance did not decrease as expected");
  } catch (err) {
    failures++;
    console.error("FAILED:", err);
  }

  // --- Test 3: Raydium CLMM — sell 0.01 SOL for USD1 ---
  console.log("\n=== Test 3: Raydium CLMM (sell SOL for USD1) ===");
  try {
    const before = await connection.getBalance(wallet.publicKey, "confirmed");
    const { txId } = await swapConcentrated(connection, wallet, RAYDIUM_USD1_SOL_CLMM, SOL_MINT, new BN(0.01 * LAMPORTS_PER_SOL), 100);
    const after = await connection.getBalance(wallet.publicKey, "confirmed");
    console.log(`OK. txId=${txId} SOL balance ${before / LAMPORTS_PER_SOL} -> ${after / LAMPORTS_PER_SOL}`);
    if (after >= before) throw new Error("SOL balance did not decrease as expected");
  } catch (err) {
    failures++;
    console.error("FAILED:", err);
  }

  console.log(`\n${3 - failures}/3 swap paths succeeded against forked mainnet state.`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
