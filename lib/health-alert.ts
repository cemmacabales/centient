import { redis } from "./redis";

const DEFAULT_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const ALERT_KEY_PREFIX = "t2p:health-alert:";

export type HealthAlertSeverity = "WARN" | "PAGE";

export interface HealthAlert {
  key: string;
  severity: HealthAlertSeverity;
  title: string;
  lines: string[];
}

export type HealthAlertDelivery = "disabled" | "failed" | "sent" | "suppressed";

function configuredCooldownMs(): number {
  const value = Number(process.env.HEALTH_ALERT_COOLDOWN_MS ?? DEFAULT_ALERT_COOLDOWN_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_ALERT_COOLDOWN_MS;
}

export async function sendDedupedDiscordAlert(
  alert: HealthAlert,
  {
    cooldownMs = configuredCooldownMs(),
    nowMs = Date.now(),
  }: { cooldownMs?: number; nowMs?: number } = {},
): Promise<HealthAlertDelivery> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return "disabled";

  const redisKey = `${ALERT_KEY_PREFIX}${alert.key}`;
  try {
    const acquired = await redis.set(redisKey, String(nowMs), "PX", cooldownMs, "NX");
    if (acquired !== "OK") return "suppressed";
  } catch (error) {
    console.error("[health-alert] Redis cooldown unavailable", error);
    return "failed";
  }

  const color = alert.severity === "PAGE" ? 0xe84118 : 0xf57c00;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: alert.title,
            color,
            description: alert.lines.join("\n"),
            timestamp: new Date(nowMs).toISOString(),
          },
        ],
      }),
    });

    if (response.ok) return "sent";
    console.error(`[health-alert] Discord webhook returned ${response.status}`);
  } catch (error) {
    console.error("[health-alert] Discord webhook failed", error);
  }

  try {
    await redis.del(redisKey);
  } catch (error) {
    console.error("[health-alert] Failed to release cooldown", error);
  }
  return "failed";
}
