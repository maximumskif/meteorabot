#!/usr/bin/env bash
set -euo pipefail

SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
export PATH="$SOLANA_BIN:$PATH"

LEDGER_DIR="/tmp/gaytry-fork-test-ledger"
RPC_PORT=8899
RPC_URL="http://127.0.0.1:${RPC_PORT}"

rm -rf "$LEDGER_DIR"

# Programs need --clone-upgradeable-program (copies the executable data too, not just the
# thin program account) — plain --clone on a program account produced "UnsupportedProgramId"
# when actually sending a tx, confirmed live.
PROGRAM_ACCOUNTS=(
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
  675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
)

# Bin array addresses shift as JitoSOL/SOL's price moves, so a hardcoded list captured
# minutes earlier can miss — resolve them fresh, immediately before launching the
# validator, to keep the gap to seconds instead of minutes.
echo "Resolving current Meteora bin arrays (fresh, right before fork launch)..."
mapfile -t METEORA_BIN_ARRAYS < <(npx tsx scripts/resolveMeteoraBinArrays.ts 2>/dev/null | grep -vE "^\(node:|bigint:")
echo "Resolved: ${METEORA_BIN_ARRAYS[*]}"

# Accounts discovered live against real mainnet state (scripts/discoverAccounts.ts) —
# every account each of the three swap paths actually touches, cloned exactly, not guessed.
CLONE_ACCOUNTS=(
  # Meteora DLMM: JitoSOL/SOL, not SOL/USDC — SOL/USDC is one of the most actively-traded
  # Meteora pools on Solana and kept shifting its active bin between discovery and fork.
  # JitoSOL/SOL is far quieter (trades near a slow-moving ~1:1 ratio).
  # (throwaway-wallet ATAs excluded — those don't exist yet, they get created by the tx itself)
  BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U
  A5vcWC2AAx7JA4bcigkH7LmDqwZRGCfzvFgoz1rweqjb
  93d6ukn24o1xMcMDip2SACKG8GbvhGUZim1e3ZEcQVm2
  CodroyzrRNvc5kHRoAQYjpVSr1jA9fLcUWVFouiuWGsD
  J8qTtVLNPh2tMhogdndv2v8Y1x85HYGztpehkPKmHRSK
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
  D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6
  "${METEORA_BIN_ARRAYS[@]}"
  # Raydium AMM v4: pool, vaults, open orders/market accounts
  58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2
  5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1
  DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz
  HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz
  # Raydium CLMM: pool, config, tick arrays, bitmap extension, observation
  AQAGYQsdU853WAKhXM79CgNdoyhrRwXvYHX6qrDyC1FS
  E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp
  5QpMZ6MuyKjg8Qa1X8gM5G3YMsd43rpHb2iQ6hdcRM7m
  DHY2efKhMcZyAgmPw82C2Gez1e98Ab7oWcXfxz9frUCr
  2s8VC2vpZcoUCbvEqwUagvdyHfUeWYQZuKV376acx6iF
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
  HKcNrRDTFuXVTyMCkp5h3eU4cyqbzteAW1UR7m2CWbVs
  DTgyhdzARWt8fiFrA5E2ECTdR5U3rpGho2AmaPWsieWg
  9bcapqGioeAGybVSbtYoSZR23qZESNbToTV5C2QUJMqZ
  8Ndgz7gY9zV2nAnMnPB4wgvmU8aT7FrxLdyqe6GD5zGv
  # Shared: token mints
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn
)

CLONE_ARGS=()
for acct in "${PROGRAM_ACCOUNTS[@]}"; do
  CLONE_ARGS+=(--clone-upgradeable-program "$acct")
done
for acct in "${CLONE_ACCOUNTS[@]}"; do
  CLONE_ARGS+=(--clone "$acct")
done

echo "Starting solana-test-validator (fork of mainnet-beta, ${#PROGRAM_ACCOUNTS[@]} programs + ${#CLONE_ACCOUNTS[@]} accounts cloned)..."
solana-test-validator \
  --url https://api.mainnet-beta.solana.com \
  "${CLONE_ARGS[@]}" \
  --ledger "$LEDGER_DIR" \
  --rpc-port "$RPC_PORT" \
  --reset \
  --quiet \
  > /tmp/gaytry-fork-test-validator.log 2>&1 &

VALIDATOR_PID=$!
echo "Validator PID: $VALIDATOR_PID"

echo "Waiting for RPC to be ready..."
for i in $(seq 1 60); do
  if solana cluster-version --url "$RPC_URL" > /dev/null 2>&1; then
    echo "RPC ready after ${i}s."
    break
  fi
  sleep 1
done

if ! solana cluster-version --url "$RPC_URL" > /dev/null 2>&1; then
  echo "Validator failed to become ready. Log tail:"
  tail -50 /tmp/gaytry-fork-test-validator.log
  kill "$VALIDATOR_PID" 2>/dev/null || true
  exit 1
fi

echo "Running fork swap test..."
set +e
FORK_RPC_URL="$RPC_URL" npx tsx scripts/forkTestSwap.ts
TEST_EXIT=$?
set -e

echo "Stopping validator (PID $VALIDATOR_PID)..."
kill "$VALIDATOR_PID" 2>/dev/null || true
wait "$VALIDATOR_PID" 2>/dev/null || true

exit $TEST_EXIT
