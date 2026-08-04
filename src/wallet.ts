import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export function loadWallet(secretKeyBase58: string): Keypair {
  const secretKey = bs58.decode(secretKeyBase58);
  return Keypair.fromSecretKey(secretKey);
}

export function createConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, "confirmed");
}
