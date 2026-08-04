# gaytry

A cross-DEX Solana arbitrage paper-trading bot (TypeScript/Node, `tsx` runtime).
Compares a token pair's price on **Meteora DLMM** against its price on **Raydium**
(AMM + CLMM) and paper-trades a two-leg arb when the spread is wide enough to be
profitable net of assumed costs. No real funds or wallet involved yet.

**Status:** paper-trading only. Wallet/execution code (`src/wallet.ts`,
`src/meteora.ts`'s `executeSwap`) exists but is dormant (`DRY_RUN=true`) — nothing
signs or sends a transaction. Prices are read via each venue's own REST API for
routine polling, with a fresh on-chain RPC read to confirm any signal before it's
paper-filled (see below) — no wallet needed for either.

## Why cross-DEX, not vs. a CEX

An earlier version compared Meteora's price to Coinbase spot and bet on
reversion — an unhedged directional bet, not a real arbitrage. Meteora and
Raydium are both on-chain and executable near-simultaneously, so a dislocation
between them is a genuine, hedgeable arb: buy the cheap venue, sell the
expensive one. Jupiter's aggregate quote is used only as a cross-check/log,
not as a trading venue (it routes through Raydium/Meteora/others, it isn't
independent liquidity).

## How it works

1. **Scan** (`npm run scan-pairs`): pull Meteora's top pools by TVL
   (`dlmm.datapi.meteora.ag`), then check Raydium (`api-v3.raydium.io`) for a
   matching pool on the same pair. Keep pairs with real liquidity on both
   venues (`MIN_POOL_TVL_USD`), compute the current spread, and write a
   ranked shortlist to `candidates.json`.
2. **Monitor** (`npm start`): poll each candidate's Meteora + Raydium price
   every `POLL_INTERVAL_MS` via REST — cheap, but confirmed live to be an
   indexer/cache layer that can return bit-for-bit identical prices across
   2+ minutes of polling, so it's only trusted to decide "is this worth a
   closer look," never to fire a trade.
3. If the REST spread exceeds `ENTRY_THRESHOLD_BPS` + `ASSUMED_ROUND_TRIP_COST_BPS`,
   re-check with a **fresh on-chain RPC read** on both venues (Meteora via
   `src/meteora.ts`'s DLMM SDK, Raydium via `src/dex/raydiumOnchain.ts`'s
   `@raydium-io/raydium-sdk-v2` — AMM and CLMM pools both handled). If the
   spread doesn't survive that fresh read, it's rejected as stale REST data,
   not filled.
4. If it survives, cross-check against a live Jupiter quote and reject if
   Jupiter disagrees sharply (`JUPITER_SANITY_BPS`) — caught a pair reporting
   a fake profit from bad pricing on a thin pool during testing. Otherwise
   paper-fill both legs immediately (buy cheap venue, sell expensive venue) —
   profit is realized at fill, not on later convergence. A per-pair
   `TRADE_COOLDOWN_MS` prevents re-triggering on noisy consecutive ticks.
5. Log every fill to a JSONL trade log (`src/paperTrader.ts`).

**Not yet modeled:** leg risk (one side fills, price moves before the other
lands) — real execution needs two transactions in quick succession, not a
single atomic one, unless routed through a custom on-chain arb program. See
the roadmap below.

## Setup

```bash
npm install
cp .env.example .env       # defaults work; tune thresholds as you like
npm run scan-pairs         # writes candidates.json
npm start                  # or: npm run dev (watch mode)
```

## Project layout

| File | Purpose |
|---|---|
| `src/config.ts` | env-driven config |
| `src/dex/meteoraApi.ts` | Meteora DLMM pool discovery + price (REST, `dlmm.datapi.meteora.ag`) |
| `src/dex/raydiumApi.ts` | Raydium pool discovery + price (REST, `api-v3.raydium.io`) |
| `src/dex/raydiumOnchain.ts` | Raydium on-chain price (RPC, via `@raydium-io/raydium-sdk-v2`) — signal confirmation only |
| `src/dex/jupiterApi.ts` | Jupiter price/quote, used as a cross-check only |
| `src/dex/normalize.ts` | reorients Raydium's price to a common base/quote convention |
| `src/scanPairs.ts` | cross-DEX pair discovery, writes `candidates.json` |
| `src/strategy.ts` | spread calculation, entry decision |
| `src/paperTrader.ts` | two-leg paper fill + JSONL trade log |
| `src/index.ts` | main polling/paper-trading loop |
| `src/wallet.ts`, `src/generateWallet.ts` | wallet loading/generation (dormant until real execution) |
| `src/meteora.ts` | on-chain DLMM pool reads/swap execution via the SDK (dormant, needed for real execution) |

## Roadmap

1. ~~Validate paper-trading mechanism with forced trades~~ — done (earlier CEX-based version).
2. ~~Cross-DEX pair discovery~~ — done: `scanPairs.ts` + live two-leg paper-trading loop.
3. Risk management — position sizing vs. liquidity, max exposure, daily loss cap. Not started.
4. Execution readiness — model/mitigate leg risk (partial fills, price movement
   between the two txs), devnet execution test, then tiny mainnet real funds,
   gated on Phase 3 and a real sample of positive paper-trade expectancy.
   `@raydium-io/raydium-sdk-v2` is already in use for on-chain price reads;
   real swap building (vs. just reads) is still needed.
5. Operational hardening — retry/backoff, alerting, a dedicated RPC provider
   (the public endpoint is fine for on-signal confirmation calls today, but
   will need replacing once execution needs lower latency/higher reliability).

## Notes

- `.env` and `candidates.json` are gitignored — never commit real RPC
  endpoints, a wallet secret key, or assume a stale candidate list is current
  (liquidity/spreads move; re-run `scan-pairs` periodically).
- Built by verifying every SDK/API claim against live, installed packages and
  real endpoints rather than assuming API shapes from memory — the old
  `dlmm-api.meteora.ag` host, for example, is fully dead; the current one is
  `dlmm.datapi.meteora.ag`.
