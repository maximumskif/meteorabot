# gaytry

A cross-DEX Solana arbitrage paper-trading bot (TypeScript/Node, `tsx` runtime).
Compares a token pair's price on **Meteora DLMM** against its price on **Raydium**
(AMM + CLMM) and paper-trades a two-leg arb when the spread is wide enough to be
profitable net of assumed costs. No real funds or wallet involved yet.

**Status:** paper-trading only. Wallet/execution code (`src/wallet.ts`,
`src/meteora.ts`) exists but is dormant (`DRY_RUN=true`) — the current scanner and
live loop read prices via each venue's own REST API, no on-chain execution.

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
   every `POLL_INTERVAL_MS` (REST only, no RPC calls in the hot path).
3. If the spread exceeds `ENTRY_THRESHOLD_BPS` + `ASSUMED_ROUND_TRIP_COST_BPS`,
   paper-fill both legs immediately (buy cheap venue, sell expensive venue) —
   profit is realized at fill, not on later convergence. Cross-check against a
   live Jupiter quote and log it alongside the trade. A per-pair
   `TRADE_COOLDOWN_MS` prevents re-triggering on noisy consecutive ticks.
4. Log every fill to a JSONL trade log (`src/paperTrader.ts`).

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
   Needs `@raydium-io/raydium-sdk-v2` for real Raydium swap building (not
   added yet — REST-only for reads so far).
5. Operational hardening — dedicated RPC (only needed once real execution via
   the DLMM SDK is wired up), retry/backoff, alerting.

## Notes

- `.env` and `candidates.json` are gitignored — never commit real RPC
  endpoints, a wallet secret key, or assume a stale candidate list is current
  (liquidity/spreads move; re-run `scan-pairs` periodically).
- Built by verifying every SDK/API claim against live, installed packages and
  real endpoints rather than assuming API shapes from memory — the old
  `dlmm-api.meteora.ag` host, for example, is fully dead; the current one is
  `dlmm.datapi.meteora.ag`.
