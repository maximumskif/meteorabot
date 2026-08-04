const BASE_URL = "https://lite-api.jup.ag";

interface JupiterPriceV3Entry {
  usdPrice: number;
  liquidity: number;
  decimals: number;
}

/** Lightweight USD price per mint (no full swap route). */
export async function fetchPriceV3(mints: string[]): Promise<Record<string, JupiterPriceV3Entry>> {
  const res = await fetch(`${BASE_URL}/price/v3?ids=${mints.join(",")}`);
  if (!res.ok) {
    throw new Error(`Jupiter price fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<Record<string, JupiterPriceV3Entry>>;
}

export interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: { swapInfo: { label: string; ammKey: string } }[];
}

/** Aggregate swap quote, used only as a signal cross-check (rate-limited to 30/min on the free tier). */
export async function fetchQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  opts: { slippageBps?: number; excludeDexes?: string[] } = {}
): Promise<JupiterQuote> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: String(opts.slippageBps ?? 50),
  });
  if (opts.excludeDexes?.length) {
    params.set("excludeDexes", opts.excludeDexes.join(","));
  }
  const res = await fetch(`${BASE_URL}/swap/v1/quote?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Jupiter quote fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<JupiterQuote>;
}
