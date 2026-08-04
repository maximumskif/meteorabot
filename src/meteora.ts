import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey, Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";

export async function loadPool(connection: Connection, poolAddress: string) {
  return DLMM.create(connection, new PublicKey(poolAddress));
}

const poolCache = new Map<string, ReturnType<typeof loadPool>>();

/** Cached pool handle (pool metadata is static); callers still re-fetch getPrice() for fresh reserves. */
export function getOrLoadPool(connection: Connection, poolAddress: string) {
  let cached = poolCache.get(poolAddress);
  if (!cached) {
    cached = loadPool(connection, poolAddress);
    poolCache.set(poolAddress, cached);
  }
  return cached;
}

export async function getPrice(pool: Awaited<ReturnType<typeof loadPool>>) {
  const activeBin = await pool.getActiveBin();
  return {
    binId: activeBin.binId,
    price: Number(activeBin.pricePerToken),
  };
}

export async function quoteSwap(
  pool: Awaited<ReturnType<typeof loadPool>>,
  inAmount: BN,
  swapForY: boolean,
  allowedSlippageBps: number
) {
  const binArrays = await pool.getBinArrayForSwap(swapForY);
  const allowedSlippage = new BN(allowedSlippageBps);
  return pool.swapQuote(inAmount, swapForY, allowedSlippage, binArrays);
}

/**
 * Quotes a fill for a fixed USD notional against tokenX (base, e.g. SOL) / tokenY
 * (USD-pegged quote, e.g. USDC). "buy" spends Y to acquire X; "sell" spends X for Y.
 * approxPrice (Y per X) is only used to size the sell-side input amount.
 */
export async function quoteEntryOrExit(
  pool: Awaited<ReturnType<typeof loadPool>>,
  side: "buy" | "sell",
  notionalUsd: number,
  approxPrice: number,
  slippageBps: number
) {
  const swapForY = side === "sell";
  const inAmount = swapForY
    ? new BN(Math.round((notionalUsd / approxPrice) * 10 ** pool.tokenX.mint.decimals))
    : new BN(Math.round(notionalUsd * 10 ** pool.tokenY.mint.decimals));

  const quote = await quoteSwap(pool, inAmount, swapForY, slippageBps);

  const inDecimals = swapForY ? pool.tokenX.mint.decimals : pool.tokenY.mint.decimals;
  const outDecimals = swapForY ? pool.tokenY.mint.decimals : pool.tokenX.mint.decimals;
  const inHuman = Number(inAmount.toString()) / 10 ** inDecimals;
  const outHuman = Number(quote.outAmount.toString()) / 10 ** outDecimals;

  const effectivePrice = swapForY ? outHuman / inHuman : inHuman / outHuman;

  return { quote, effectivePrice };
}

export async function executeSwap(
  connection: Connection,
  pool: Awaited<ReturnType<typeof loadPool>>,
  wallet: Keypair,
  inAmount: BN,
  swapForY: boolean,
  quote: Awaited<ReturnType<typeof quoteSwap>>
) {
  const inToken = swapForY ? pool.tokenX.publicKey : pool.tokenY.publicKey;
  const outToken = swapForY ? pool.tokenY.publicKey : pool.tokenX.publicKey;

  const swapTx = await pool.swap({
    inToken,
    outToken,
    inAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: pool.pubkey,
    user: wallet.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });

  return sendAndConfirmTransaction(connection, swapTx, [wallet]);
}
