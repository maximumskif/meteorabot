export async function fetchCexPrice(baseUrl: string, pair: string): Promise<number> {
  const res = await fetch(`${baseUrl}/${pair}/spot`);
  if (!res.ok) {
    throw new Error(`CEX price fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data: { amount: string } };
  const price = Number(json.data.amount);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`CEX price fetch returned invalid amount: ${json.data.amount}`);
  }
  return price;
}
