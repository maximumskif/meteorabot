import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const pairs = await DLMM.getLbPairs(connection, { cluster: "devnet" });

  const solPairs = pairs.filter(
    (p) =>
      p.account.tokenXMint.toBase58() === SOL_MINT ||
      p.account.tokenYMint.toBase58() === SOL_MINT
  );

  console.log(`${pairs.length} total pairs, ${solPairs.length} paired with SOL. Checking active-bin liquidity on a sample...\n`);

  const sample = solPairs.slice(0, 60);
  const results: { pubkey: string; other: string; xAmount: string; yAmount: string }[] = [];

  for (const p of sample) {
    try {
      const pool = await DLMM.create(connection, p.publicKey, { cluster: "devnet" });
      const bin = await pool.getActiveBin();
      if (bin.xAmount.gtn(0) && bin.yAmount.gtn(0)) {
        const other =
          p.account.tokenXMint.toBase58() === SOL_MINT
            ? p.account.tokenYMint.toBase58()
            : p.account.tokenXMint.toBase58();
        results.push({
          pubkey: p.publicKey.toBase58(),
          other,
          xAmount: bin.xAmount.toString(),
          yAmount: bin.yAmount.toString(),
        });
      }
    } catch {
      // skip pools that fail to load (e.g. no bin arrays initialized)
    }
  }

  results.sort((a, b) => Number(BigInt(b.xAmount) + BigInt(b.yAmount) - (BigInt(a.xAmount) + BigInt(a.yAmount))));

  console.log(`${results.length} pools with live two-sided liquidity in the active bin:\n`);
  for (const r of results.slice(0, 15)) {
    console.log(`${r.pubkey}  otherMint=${r.other}  xAmount=${r.xAmount}  yAmount=${r.yAmount}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
