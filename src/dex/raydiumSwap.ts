import {
  Raydium,
  TxVersion,
  getPdaExBitmapAccount,
  swapInternal,
  TickArrayBitmapExtensionLayout,
  type ApiV3PoolInfoStandardItem,
  type MakeTxData,
} from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

const ownerRaydiumCache = new Map<string, Promise<Raydium>>();

/** Owner-bound Raydium instance — separate from dex/raydiumOnchain.ts's read-only (owner: undefined) one, since swap building requires a real signer. */
function getOwnerRaydium(connection: Connection, owner: Keypair): Promise<Raydium> {
  const key = owner.publicKey.toBase58();
  let cached = ownerRaydiumCache.get(key);
  if (!cached) {
    cached = Raydium.load({
      owner,
      connection,
      cluster: "mainnet",
      disableFeatureCheck: true,
      disableLoadToken: true,
      blockhashCommitment: "finalized",
    });
    ownerRaydiumCache.set(key, cached);
  }
  return cached;
}

/** Builds (but does not send) a swap on an AMM v4 ("Standard") Raydium pool. */
export async function buildStandardSwap(
  connection: Connection,
  owner: Keypair,
  poolId: string,
  inputMint: string,
  outputMint: string,
  amountIn: BN,
  slippage: number
): Promise<MakeTxData<TxVersion.LEGACY>> {
  const raydium = await getOwnerRaydium(connection, owner);

  const poolData = await raydium.api.fetchPoolById({ ids: poolId });
  const poolInfo = poolData[0] as ApiV3PoolInfoStandardItem;
  const poolKeys = await raydium.liquidity.getAmmPoolKeys(poolId);
  const rpcData = await raydium.liquidity.getRpcPoolInfo(poolId);

  const out = raydium.liquidity.computeAmountOut({
    poolInfo: {
      ...poolInfo,
      baseReserve: rpcData.baseReserve,
      quoteReserve: rpcData.quoteReserve,
      status: rpcData.status.toNumber(),
      version: 4,
    },
    amountIn,
    mintIn: inputMint,
    mintOut: outputMint,
    slippage,
  });

  return raydium.liquidity.swap({
    poolInfo,
    poolKeys,
    amountIn,
    amountOut: out.minAmountOut,
    fixedSide: "in",
    inputMint,
    txVersion: TxVersion.LEGACY,
  });
}

/** Real swap on an AMM v4 ("Standard") Raydium pool. Builds, sends, and confirms on-chain. */
export async function swapStandard(
  connection: Connection,
  owner: Keypair,
  poolId: string,
  inputMint: string,
  outputMint: string,
  amountIn: BN,
  slippage: number
): Promise<{ txId: string }> {
  const { execute } = await buildStandardSwap(connection, owner, poolId, inputMint, outputMint, amountIn, slippage);
  const { txId } = await execute({ sendAndConfirm: true });
  return { txId };
}

/** Builds (but does not send) a swap on a Concentrated (CLMM) Raydium pool. */
export async function buildConcentratedSwap(
  connection: Connection,
  owner: Keypair,
  poolId: string,
  inputMint: string,
  amountIn: BN,
  slippageBps: number
): Promise<MakeTxData<TxVersion.LEGACY>> {
  const raydium = await getOwnerRaydium(connection, owner);
  const poolIdPub = new PublicKey(poolId);

  // zeroForOne (input is mintA vs mintB) must be known before fetching direction-specific
  // tick array data, so read the pool's mint ordering first with a cheap RPC call.
  const rpcInfoForDirection = await raydium.clmm.getRpcClmmPoolInfo({ poolId });
  const zeroForOne = inputMint === rpcInfoForDirection.mintA.toBase58();

  const { poolInfo, rpcData, configInfo, tickArrays } = await raydium.clmm.getSwapPoolInfo(poolId, zeroForOne);

  const programId = new PublicKey(poolInfo.programId);
  const tickArrayBitmapExtensionPda = getPdaExBitmapAccount(programId, poolIdPub).publicKey;
  const tickArrayBitmapExtensionAccount = await connection.getAccountInfo(tickArrayBitmapExtensionPda);
  if (!tickArrayBitmapExtensionAccount) {
    throw new Error("tick array bitmap extension account not found");
  }

  const simulation = swapInternal({
    programId,
    poolId: poolIdPub,
    poolInfo: rpcData,
    tickArrays,
    configInfo,
    tickarrayBitmapExtension: TickArrayBitmapExtensionLayout.decode(tickArrayBitmapExtensionAccount.data),
    amountSpecified: amountIn,
    sqrtPriceLimitX64: new BN(0),
    zeroForOne,
    isBaseInput: true,
    blockTimestamp: Math.floor(Date.now() / 1000),
    includeExtraTickArrays: true,
  });

  // swapInternal's amountCalculated is the raw simulated output with no slippage buffer —
  // apply configured slippage ourselves so the tx has room to land instead of reverting on
  // any minor price movement between simulation and confirmation.
  const amountOutMin = simulation.amountCalculated.muln(10_000 - slippageBps).divn(10_000);

  return raydium.clmm.swap({
    poolInfo,
    inputMint,
    amountIn,
    amountOutMin,
    observationId: rpcData.observationId,
    ownerInfo: { useSOLBalance: true },
    remainingAccounts: simulation.accounts,
    txVersion: TxVersion.LEGACY,
  });
}

/** Real swap on a Concentrated (CLMM) Raydium pool. Builds, sends, and confirms on-chain. */
export async function swapConcentrated(
  connection: Connection,
  owner: Keypair,
  poolId: string,
  inputMint: string,
  amountIn: BN,
  slippageBps: number
): Promise<{ txId: string }> {
  const { execute } = await buildConcentratedSwap(connection, owner, poolId, inputMint, amountIn, slippageBps);
  const { txId } = await execute({ sendAndConfirm: true });
  return { txId };
}
