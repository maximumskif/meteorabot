import { appendFileSync } from "node:fs";
import type { Side } from "./strategy";

interface OpenPosition {
  side: Side;
  entryTime: number;
  entryFillPrice: number;
  entrySpreadBps: number;
  notionalUsd: number;
}

export class PaperTrader {
  private open: OpenPosition | null = null;

  constructor(private readonly logPath: string) {}

  hasOpenPosition(): boolean {
    return this.open !== null;
  }

  getOpenPosition(): OpenPosition | null {
    return this.open;
  }

  enter(side: Side, entryFillPrice: number, entrySpreadBps: number, notionalUsd: number) {
    this.open = { side, entryTime: Date.now(), entryFillPrice, entrySpreadBps, notionalUsd };
    this.appendLog({ event: "enter", ...this.open });
  }

  exit(exitFillPrice: number, exitSpreadBps: number, reason: "converged" | "max-hold") {
    if (!this.open) return null;

    const priceMoveBps =
      this.open.side === "buy"
        ? ((exitFillPrice - this.open.entryFillPrice) / this.open.entryFillPrice) * 10_000
        : ((this.open.entryFillPrice - exitFillPrice) / this.open.entryFillPrice) * 10_000;
    const pnlUsd = (priceMoveBps / 10_000) * this.open.notionalUsd;

    const result = {
      side: this.open.side,
      holdMs: Date.now() - this.open.entryTime,
      entryFillPrice: this.open.entryFillPrice,
      exitFillPrice,
      entrySpreadBps: this.open.entrySpreadBps,
      exitSpreadBps,
      pnlBps: priceMoveBps,
      pnlUsd,
      reason,
    };
    this.appendLog({ event: "exit", ...result });
    this.open = null;
    return result;
  }

  private appendLog(entry: Record<string, unknown>) {
    appendFileSync(this.logPath, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
  }
}
