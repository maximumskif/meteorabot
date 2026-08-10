import { fetchJson } from "./httpJson";

const BASE_URL = "https://dlmm.datapi.meteora.ag";

export interface MeteoraToken {
  address: string;
  symbol: string;
  decimals: number;
  price: number;
}

export interface MeteoraPool {
  address: string;
  token_x: MeteoraToken;
  token_y: MeteoraToken;
  current_price: number;
  tvl: number;
}

interface MeteoraPoolsResponse {
  total: number;
  pages: number;
  current_page: number;
  data: MeteoraPool[];
}

async function fetchPoolsPage(params: URLSearchParams): Promise<MeteoraPoolsResponse> {
  return fetchJson<MeteoraPoolsResponse>(`${BASE_URL}/pools?${params.toString()}`, "Meteora pools fetch");
}

/** Top DLMM pools by TVL, across `maxPages` pages of `pageSize` each. */
export async function fetchTopPoolsByTvl(pageSize: number, maxPages: number): Promise<MeteoraPool[]> {
  const pools: MeteoraPool[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      sort_by: "tvl:desc",
      page_size: String(pageSize),
      page: String(page),
    });
    const { data } = await fetchPoolsPage(params);
    if (data.length === 0) break;
    pools.push(...data);
  }
  return pools;
}

/** DLMM pools containing `mint`, sorted by TVL descending. */
export async function fetchPoolsByMint(mint: string, pageSize = 20): Promise<MeteoraPool[]> {
  const params = new URLSearchParams({
    query: mint,
    sort_by: "tvl:desc",
    page_size: String(pageSize),
  });
  const { data } = await fetchPoolsPage(params);
  return data;
}

/** Single pool by its own address, for cheap live price polling (no RPC needed). */
export async function fetchPoolByAddress(address: string): Promise<MeteoraPool | undefined> {
  const params = new URLSearchParams({ query: address, page_size: "1" });
  const { data } = await fetchPoolsPage(params);
  return data[0];
}
