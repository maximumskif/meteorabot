# gaytry

A Meteora DLMM paper-trading bot (TypeScript/Node, `tsx` runtime). Watches
the spread between a live Meteora DLMM pool price and a CEX reference price,
and paper-trades a mean-reversion signal on that spread — no real funds or
wallet involved yet.

**Status:** paper-trading only. Wallet/execution code exists but is dormant
(`DRY_RUN=true`). Currently mid-build on a pool-scanning tool to find pools
with real, persistent price dislocation (SOL/USDC was tested and is too
efficient for the signal to fire).

## How it works

1. Poll a Meteora DLMM pool's price (`src/meteora.ts`) and a CEX reference
   price — Coinbase spot API (`src/priceFeed.ts`).
2. Compute the spread in basis points (`src/strategy.ts`).
3. If the spread exceeds `ENTRY_THRESHOLD_BPS` (net of assumed round-trip
   cost), open a paper position; close it on reversion, timeout, or explicit
   exit signal.
4. Log every paper entry/exit to a JSONL trade log (`src/paperTrader.ts`).

## Setup

```bash
npm install
cp .env.example .env   # fill in RPC_URL and POOL_ADDRESS at minimum
npm start               # or: npm run dev (watch mode)
```

Find a live Meteora DLMM pool address to trade:

```bash
npm run find-pools
```

## Project layout

| File | Purpose |
|---|---|
| `src/config.ts` | env-driven config, validation |
| `src/wallet.ts`, `src/generateWallet.ts` | wallet loading/generation (dormant until real execution) |
| `src/meteora.ts` | pool loading, price/quote reads, swap execution (dormant) |
| `src/priceFeed.ts` | CEX reference price (Coinbase spot API) |
| `src/strategy.ts` | spread calculation, entry/exit decision logic |
| `src/paperTrader.ts` | position tracking + JSONL trade log |
| `src/index.ts` | main polling/paper-trading loop |
| `src/findPools.ts` | on-chain Meteora DLMM pool discovery |

## Roadmap

1. ~~Validate paper-trading mechanism with forced trades~~ — done.
2. **Pool-scanning tool** (current) — sweep pools, rank by liquidity, find
   candidates with real persistent spread.
3. Risk management — position sizing vs. liquidity, max exposure, daily
   loss cap.
4. Execution readiness — devnet test, then tiny mainnet real funds, gated
   on Phase 2 showing positive expectancy.
5. Operational hardening — dedicated RPC, retry/backoff, alerting.

## Notes

- `.env` is gitignored — never commit real RPC endpoints or a wallet secret
  key.
- Built by verifying every SDK/API claim against live, installed packages
  and real endpoints rather than assuming API shapes from memory — see
  inline comments and commit history for dead ends already ruled out.
