import { fetchJson } from "./httpJson";

const BASE_URL = "https://api-v3.raydium.io";

export interface RaydiumMint {
  address: string;
  symbol: string;
  decimals: number;
}

export interface RaydiumPool {
  id: string;
  type: "Standard" | "Concentrated";
  mintA: RaydiumMint;
  mintB: RaydiumMint;
  price: number;
  tvl: number;
}

interface RaydiumMintPoolsResponse {
  success: boolean;
  data: { count: number; data: RaydiumPool[] };
}

/** Pools for a specific mint pair (both AMM and CLMM), sorted by liquidity descending. */
export async function fetchPoolsByMints(mint1: string, mint2: string, pageSize = 10): Promise<RaydiumPool[]> {
  const params = new URLSearchParams({
    mint1,
    mint2,
    poolType: "all",
    poolSortField: "liquidity",
    sortType: "desc",
    pageSize: String(pageSize),
    page: "1",
  });
  const json = await fetchJson<RaydiumMintPoolsResponse>(`${BASE_URL}/pools/info/mint?${params.toString()}`, "Raydium pools fetch");
  return json.data.data;
}

interface RaydiumPoolByIdResponse {
  success: boolean;
  data: RaydiumPool[];
}

/** Single pool by its id, for cheap live price polling (no RPC needed). */
export async function fetchPoolById(id: string): Promise<RaydiumPool | undefined> {
  const json = await fetchJson<RaydiumPoolByIdResponse>(`${BASE_URL}/pools/info/ids?ids=${id}`, "Raydium pool fetch");
  return json.data[0];
}
