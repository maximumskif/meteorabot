# gaytry

A cross-DEX Solana arbitrage paper-trading bot (TypeScript/Node, `tsx` runtime).
Compares a token pair's price on **Meteora DLMM** against its price on **Raydium**
(AMM + CLMM) and paper-trades a two-leg arb when the spread is wide enough to be
profitable net of assumed costs. No real funds or wallet involved yet.

**Status:** paper trading always runs. Real execution code exists (Meteora + Raydium
AMM/CLMM swap building, hard risk gates, a localnet fork test that sends real
transactions against forked mainnet state with zero real funds at risk — see
`npm run fork-test`, currently passing 3/3) but is **off by default** — see
"Real execution" below before ever turning it on.

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

## Real execution (real funds — read this before touching it)

Off by default, and requires clearing several independent gates before a live
trade is ever attempted (`src/liveTrader.ts`, config in `.env.example`):

1. **`npm run fork-test` must pass 3/3.** This forks real mainnet program +
   pool state onto a local `solana-test-validator` (via `scripts/forkTest.sh`)
   and sends real transactions against it with a throwaway, locally-airdropped
   wallet — zero real funds at risk, but it proves the actual swap-building/
   signing/sending mechanics work against real current on-chain state, not
   just that the code compiles.
2. **`LIVE_TRADING_ENABLED=true` AND `I_UNDERSTAND_REAL_FUNDS_AT_RISK=true`** —
   two independent flags on purpose.
3. **`LIVE_PAIR_ALLOWLIST`** — only pairs listed here can trade live, even if
   the scanner finds others.
4. **`LIVE_TRADE_NOTIONAL_USD`** and **`LIVE_DAILY_LOSS_CAP_USD`** — both
   required, no defaults. Start small.
5. **`LIVE_MAX_POSITION_PCT_OF_TVL`** — refuses a trade too large relative to
   the thinner pool's depth, independent of the flat notional cap.
6. A pre-trade balance check (input token + a SOL fee buffer) fails closed —
   skips rather than attempts-and-errors if the wallet can't cover it.

Even with all of that: **leg risk is real and only partially mitigated.** A
"trade" is two separate transactions (buy venue, then sell venue), not one
atomic swap. Before firing leg 2, the code re-checks the sell venue's price
and aborts leg 2 (leaving a known, notional-capped single-leg position) if the
edge evaporated — but it does not try to automatically unwind that position.
That's an accepted, bounded risk at small notional, not a solved problem.

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
| `src/dex/raydiumOnchain.ts` | Raydium on-chain price reads (RPC, via `@raydium-io/raydium-sdk-v2`) — signal confirmation |
| `src/dex/raydiumSwap.ts` | Raydium on-chain swap building/sending (AMM + CLMM), real execution |
| `src/dex/jupiterApi.ts` | Jupiter price/quote, used as a cross-check only |
| `src/dex/normalize.ts` | reorients Raydium's price to a common base/quote convention |
| `src/scanPairs.ts` | cross-DEX pair discovery, writes `candidates.json` |
| `src/strategy.ts` | spread calculation, entry decision |
| `src/paperTrader.ts` | two-leg paper fill + JSONL trade log (always runs) |
| `src/liveTrader.ts` | two-leg **real** fill: risk gates, leg-risk abort, JSONL trade log |
| `src/index.ts` | main polling loop — paper always, live if gated on |
| `src/wallet.ts`, `src/generateWallet.ts` | wallet loading/generation |
| `src/meteora.ts` | on-chain DLMM pool reads/swap execution via the SDK |
| `src/dashboard.ts` | local live dashboard (`npm run dashboard`) — reads `paper-trades.jsonl` |
| `scripts/forkTest.sh`, `scripts/forkTestSwap.ts` | localnet fork test — the safety gate before real execution |
| `scripts/discoverAccounts.ts`, `scripts/resolveMeteoraBinArrays.ts` | dev tools for finding which accounts a swap touches (used to build the fork test's clone list) |

## Roadmap

1. ~~Validate paper-trading mechanism with forced trades~~ — done (earlier CEX-based version).
2. ~~Cross-DEX pair discovery~~ — done: `scanPairs.ts` + live two-leg paper-trading loop.
3. ~~Risk management~~ — done: pair allowlist, notional cap, daily loss cap, TVL-relative
   position cap, pre-trade balance check (`src/liveTrader.ts`, `.env.example`).
4. ~~Execution readiness~~ — done: real swap building for Meteora + Raydium (AMM/CLMM),
   verified against a localnet fork of real mainnet state (`npm run fork-test`, 3/3
   passing). Leg risk (two non-atomic transactions) is mitigated by a pre-leg-2 price
   re-check but not eliminated — see "Real execution" above. Not yet done: an actual
   live trade with real funds (deliberately not automated — a decision to make in the
   moment, not something this build should do on its own).
5. Operational hardening — retry/backoff, alerting, a dedicated RPC provider
   (the public endpoint is fine for on-signal confirmation calls today, but
   will need replacing once execution needs lower latency/higher reliability).
   ~~Persist the daily loss cap across restarts~~ — done: `LiveTrader` now
   loads/saves today's realized P&L to `LIVE_DAILY_PNL_STATE_PATH`
   (`live-daily-pnl.json` by default) on every fill and day rollover, so a
   crash or restart mid-day doesn't quietly reopen the cap.

## Notes

- `.env` and `candidates.json` are gitignored — never commit real RPC
  endpoints, a wallet secret key, or assume a stale candidate list is current
  (liquidity/spreads move; re-run `scan-pairs` periodically).
- Built by verifying every SDK/API claim against live, installed packages and
  real endpoints rather than assuming API shapes from memory — the old
  `dlmm-api.meteora.ag` host, for example, is fully dead; the current one is
  `dlmm.datapi.meteora.ag`.
