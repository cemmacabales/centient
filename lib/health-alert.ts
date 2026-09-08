import { randomUUID } from "node:crypto";
import { redis } from "./redis";

const DEFAULT_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_ALERT_DELIVERY_TIMEOUT_MS = 10_000;
const ALERT_DELIVERY_LEASE_MS = 30_000;
const ALERT_KEY_PREFIX = "t2p:health-alert:";

const PROMOTE_OWNED_LEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("psetex", KEYS[1], ARGV[2], ARGV[1])
end
return 0`;

const DELETE_OWNED_LEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

const pageFallbackExpiries = new Map<string, number>();

export type HealthAlertSeverity = "WARN" | "PAGE";

export interface HealthAlert {
  key: string;
  severity: HealthAlertSeverity;
  title: string;
  lines: string[];
}

export type HealthAlertDelivery =
  | "disabled"
  | "failed"
  | "sent"
  | "suppressed"
  | "sent-degraded"
  | "suppressed-degraded";

function configuredCooldownMs(): number {
  const value = Number(process.env.HEALTH_ALERT_COOLDOWN_MS ?? DEFAULT_ALERT_COOLDOWN_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_ALERT_COOLDOWN_MS;
}

function configuredDeliveryTimeoutMs(): number {
  const value = Number(
    process.env.HEALTH_ALERT_DELIVERY_TIMEOUT_MS ?? DEFAULT_ALERT_DELIVERY_TIMEOUT_MS,
  );
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_ALERT_DELIVERY_TIMEOUT_MS;
  return Math.min(value, ALERT_DELIVERY_LEASE_MS - 1);
}

async function deliverDiscordAlert(
  webhookUrl: string,
  alert: HealthAlert,
  nowMs: number,
): Promise<boolean> {
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
      signal: AbortSignal.timeout(configuredDeliveryTimeoutMs()),
    });

    if (response.ok) return true;
    console.error(`[health-alert] Discord webhook returned ${response.status}`);
  } catch (error) {
    console.error("[health-alert] Discord webhook failed", error);
  }
  return false;
}

async function deliverPageWithoutRedis(
  alertKey: string,
  webhookUrl: string,
  alert: HealthAlert,
  cooldownMs: number,
  nowMs: number,
): Promise<HealthAlertDelivery> {
  for (const [key, expiresAt] of pageFallbackExpiries) {
    if (expiresAt <= nowMs) pageFallbackExpiries.delete(key);
  }

  if (pageFallbackExpiries.has(alertKey)) return "suppressed-degraded";
  if (!(await deliverDiscordAlert(webhookUrl, alert, nowMs))) return "failed";

  pageFallbackExpiries.set(alertKey, nowMs + cooldownMs);
  return "sent-degraded";
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
  const token = randomUUID();
  try {
    const acquired = await redis.set(redisKey, token, "PX", ALERT_DELIVERY_LEASE_MS, "NX");
    if (acquired !== "OK") return "suppressed";
  } catch (error) {
    console.error("[health-alert] Redis delivery lease unavailable", error);
    if (alert.severity === "WARN") return "failed";
    return deliverPageWithoutRedis(alert.key, webhookUrl, alert, cooldownMs, nowMs);
  }

  if (await deliverDiscordAlert(webhookUrl, alert, nowMs)) {
    try {
      const promoted = await redis.eval(
        PROMOTE_OWNED_LEASE,
        1,
        redisKey,
        token,
        String(cooldownMs),
      );
      return promoted === 1 ? "sent" : "sent-degraded";
    } catch (error) {
      console.error("[health-alert] Failed to promote delivery lease", error);
      return "sent-degraded";
    }
  }

  try {
    await redis.eval(DELETE_OWNED_LEASE, 1, redisKey, token);
  } catch (error) {
    console.error("[health-alert] Failed to release delivery lease", error);
  }
  return "failed";
}
