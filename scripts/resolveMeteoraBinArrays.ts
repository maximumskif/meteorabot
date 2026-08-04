import { Connection } from "@solana/web3.js";
import { loadPool } from "../src/meteora";

const METEORA_JITOSOL_SOL = "BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U";

(async () => {
  const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const pool = await loadPool(connection, METEORA_JITOSOL_SOL);
  // quoteSwap() calls getBinArrayForSwap with no explicit count, which defaults to 4
  // inside the SDK itself (confirmed by reading the installed package's source) — every
  // earlier attempt here under-cloned because of an assumption that the default was
  // smaller. Matching the SDK's real default exactly, not guessing at a "safe" number.
  const arrays = await pool.getBinArrayForSwap(false, 4);
  for (const a of arrays) console.log(a.publicKey.toBase58());
})();
