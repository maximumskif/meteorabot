import { config } from "./config";
import { withRetry } from "./retry";

/**
 * Fire-and-forget Discord webhook notification for real-money events. No-ops if
 * ALERT_DISCORD_WEBHOOK_URL isn't set. Deliberately not awaited by callers — alerting
 * must never slow down or block trading logic, especially the leg-risk window between
 * leg 1 and leg 2. A failed send (after a couple of retries) is logged, not thrown.
 */
export function sendAlert(message: string): void {
  if (!config.alertDiscordWebhookUrl) return;
  withRetry(
    async () => {
      const res = await fetch(config.alertDiscordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message.slice(0, 2000) }), // Discord's hard content limit
      });
      if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${res.statusText}`);
    },
    { retries: 2, baseDelayMs: 500, label: "Discord alert" }
  ).catch((err) => {
    console.error(`Failed to send Discord alert: ${(err as Error).message}`);
  });
}
