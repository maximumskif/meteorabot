/** Raydium's `price` is mintA-priced-in-mintB; reorient to a given canonical base mint. */
export function raydiumPriceInCanonical(raydiumPrice: number, raydiumMintA: string, canonicalBase: string): number {
  return raydiumMintA === canonicalBase ? raydiumPrice : 1 / raydiumPrice;
}
