import { fetchJson } from "./httpJson";

const BASE_URL = "https://lite-api.jup.ag";

interface JupiterPriceV3Entry {
  usdPrice: number;
  liquidity: number;
  decimals: number;
}

/** Lightweight USD price per mint (no full swap route). */
export async function fetchPriceV3(mints: string[]): Promise<Record<string, JupiterPriceV3Entry>> {
  return fetchJson<Record<string, JupiterPriceV3Entry>>(`${BASE_URL}/price/v3?ids=${mints.join(",")}`, "Jupiter price fetch");
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
  return fetchJson<JupiterQuote>(`${BASE_URL}/swap/v1/quote?${params.toString()}`, "Jupiter quote fetch");
}
