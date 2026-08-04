import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { config } from "./config";

const PORT = Number(process.env.DASHBOARD_PORT ?? 4173);

function loadTrades(): unknown[] {
  if (!existsSync(config.tradeLogPath)) return [];
  return readFileSync(config.tradeLogPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const server = createServer((req, res) => {
  if (req.url === "/api/trades") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadTrades()));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}  (reading ${config.tradeLogPath})`);
});

const PAGE = /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>gaytry — live paper trades</title>
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --gridline: #e1e0d9;
    --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6;
    --good: #0ca30c;
    --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --muted: #898781;
      --gridline: #2c2c2a;
      --border: rgba(255,255,255,0.10);
      --series-1: #3987e5;
      --good: #0ca30c;
      --critical: #e66767;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--page);
    color: var(--text-primary);
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 60px; }
  header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 8px; }
  h1 { font-size: 20px; margin: 0; }
  .sub { color: var(--text-secondary); font-size: 13px; }
  .pulse { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); animation: blink 2s ease-in-out infinite; }
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .tile {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
  }
  .tile .label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .tile .value { font-size: 24px; font-weight: 600; font-variant-numeric: normal; }
  .tile .value.good { color: var(--good); }
  .tile .value.critical { color: var(--critical); }

  h2 { font-size: 14px; color: var(--text-secondary); margin: 28px 0 10px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--gridline); font-variant-numeric: tabular-nums; white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.02em; }
  tr:last-child td { border-bottom: none; }
  .pnl.good { color: var(--good); }
  .pnl.critical { color: var(--critical); }
  .empty { color: var(--muted); font-size: 13px; padding: 24px 0; text-align: center; }
  .venue { color: var(--series-1); font-weight: 500; }
  .scroll { overflow-x: auto; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>gaytry — live paper trades</h1>
      <div class="sub">Meteora &harr; Raydium cross-DEX arb, paper-trading only</div>
    </div>
    <div class="pulse"><span class="dot"></span><span id="updated">connecting…</span></div>
  </header>

  <div class="tiles" id="tiles"></div>

  <h2>Fills (most recent first)</h2>
  <div class="scroll">
    <table>
      <thead>
        <tr><th>Time</th><th>Pair</th><th>Buy</th><th>Sell</th><th>Entry spread</th><th>Net PnL</th><th>PnL $</th></tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div id="empty" class="empty" style="display:none">No fills yet — waiting for a signal to clear the entry threshold and survive on-chain + Jupiter confirmation.</div>
</div>

<script>
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtNum(n, digits) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function tile(label, value, cls) {
  return '<div class="tile"><div class="label">' + label + '</div><div class="value' + (cls ? " " + cls : "") + '">' + value + "</div></div>";
}

async function refresh() {
  let trades;
  try {
    const res = await fetch("/api/trades");
    trades = await res.json();
  } catch (e) {
    document.getElementById("updated").textContent = "connection lost";
    return;
  }

  trades = trades.slice().reverse();
  const totalPnl = trades.reduce((a, t) => a + t.pnlUsd, 0);
  const wins = trades.filter((t) => t.pnlUsd > 0).length;
  const winRate = trades.length ? (100 * wins / trades.length) : 0;

  const tiles = [
    tile("Fills", trades.length),
    tile("Net PnL", (totalPnl >= 0 ? "+$" : "-$") + fmtNum(Math.abs(totalPnl), 2), totalPnl >= 0 ? "good" : "critical"),
    tile("Win rate", fmtNum(winRate, 0) + "%"),
    tile("Pairs traded", new Set(trades.map((t) => t.pairKey)).size),
  ];
  document.getElementById("tiles").innerHTML = tiles.join("");

  const rows = trades.map((t) => {
    const pnlCls = t.pnlUsd >= 0 ? "good" : "critical";
    const sign = t.pnlUsd >= 0 ? "+" : "-";
    return "<tr>" +
      "<td>" + fmtTime(t.time) + "</td>" +
      "<td>" + t.pairKey + "</td>" +
      '<td><span class="venue">' + t.buyVenue + "</span> @ " + fmtNum(t.buyFillPrice, 6) + "</td>" +
      '<td><span class="venue">' + t.sellVenue + "</span> @ " + fmtNum(t.sellFillPrice, 6) + "</td>" +
      "<td>" + fmtNum(t.entrySpreadBps, 1) + " bps</td>" +
      '<td class="pnl ' + pnlCls + '">' + fmtNum(t.netPnlBps, 1) + " bps</td>" +
      '<td class="pnl ' + pnlCls + '">' + sign + "$" + fmtNum(Math.abs(t.pnlUsd), 2) + "</td>" +
      "</tr>";
  });
  document.getElementById("rows").innerHTML = rows.join("");
  document.getElementById("empty").style.display = trades.length ? "none" : "block";
  document.getElementById("updated").textContent = "updated " + new Date().toLocaleTimeString();
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
