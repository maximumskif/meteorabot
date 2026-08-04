import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const keypair = Keypair.generate();

console.log("Public key: ", keypair.publicKey.toBase58());
console.log("Secret key (base58, put this in .env as WALLET_SECRET_KEY):");
console.log(bs58.encode(keypair.secretKey));
console.log(
  "\nFund it on devnet with: solana airdrop 2 " +
    keypair.publicKey.toBase58() +
    " --url devnet"
);
