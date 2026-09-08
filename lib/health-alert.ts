import { redis } from "./redis";
import { withRedisTimeout } from "./redis-bounded";

const DEFAULT_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_ALERT_DELIVERY_TIMEOUT_MS = 10_000;
const ALERT_DELIVERY_LEASE_MS = 30_000;
const ALERT_KEY_PREFIX = "t2p:health-alert:";

// PSETEX answers "OK"; return an explicit 1 so the caller's success check is a
// single unambiguous value rather than a Redis command's own reply type.
const PROMOTE_OWNED_LEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  redis.call("psetex", KEYS[1], ARGV[2], ARGV[1])
  return 1
end
return 0`;

const DELETE_OWNED_LEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

// Local PAGE bookkeeping shared by BOTH the Redis and the degraded path: a peer
// whose Redis call failed delivers through the fallback, and a Redis lease alone
// cannot see that in-flight delivery. Ownership is claimed before any webhook.
const pageFallbackExpiries = new Map<string, number>();
const pageFallbackOwners = new Map<string, string>();

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

/**
 * Never log an error object, its message, or its name: Discord webhook URLs and
 * Redis connection strings surface inside URL/connection errors, their `cause`
 * chains, and attacker-influenced `name` fields. Only the class is safe.
 */
function safeErrorLabel(error: unknown): string {
  if (error instanceof Error) return error.constructor?.name ?? "Error";
  return typeof error;
}

function deliveryToken(): string {
  return globalThis.crypto.randomUUID();
}

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
    console.error("[health-alert] Discord webhook failed", safeErrorLabel(error));
  }
  return false;
}

function pruneExpiredPageFallbacks(nowMs: number): void {
  for (const [key, expiresAt] of pageFallbackExpiries) {
    if (expiresAt <= nowMs) pageFallbackExpiries.delete(key);
  }
}

/** Take local delivery ownership of a PAGE key, or report that a peer holds it. */
function claimLocalPage(alertKey: string, token: string, nowMs: number): boolean {
  pruneExpiredPageFallbacks(nowMs);
  if (pageFallbackExpiries.has(alertKey) || pageFallbackOwners.has(alertKey)) return false;
  pageFallbackOwners.set(alertKey, token);
  return true;
}

function releaseLocalPage(alertKey: string, token: string): void {
  if (pageFallbackOwners.get(alertKey) === token) pageFallbackOwners.delete(alertKey);
}

function completeLocalPage(
  alertKey: string,
  token: string,
  cooldownMs: number,
  nowMs: number,
): void {
  if (pageFallbackOwners.get(alertKey) !== token) return;
  pageFallbackOwners.delete(alertKey);
  pruneExpiredPageFallbacks(nowMs);
  pageFallbackExpiries.set(alertKey, nowMs + cooldownMs);
}

async function deliverPageWithoutRedis(
  alertKey: string,
  token: string,
  webhookUrl: string,
  alert: HealthAlert,
  cooldownMs: number,
  nowMs: number,
): Promise<HealthAlertDelivery> {
  if (!claimLocalPage(alertKey, token, nowMs)) return "suppressed-degraded";

  if (!(await deliverDiscordAlert(webhookUrl, alert, nowMs))) {
    releaseLocalPage(alertKey, token);
    return "failed";
  }

  completeLocalPage(alertKey, token, cooldownMs, nowMs);
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
  const token = deliveryToken();
  const isPage = alert.severity === "PAGE";

  let acquired: unknown;
  try {
    // A lease that lands after this deadline is abandoned but harmless: it holds
    // our own token and expires on its own after ALERT_DELIVERY_LEASE_MS.
    acquired = await withRedisTimeout(
      "alert lease",
      redis.set(redisKey, token, "PX", ALERT_DELIVERY_LEASE_MS, "NX"),
    );
  } catch (error) {
    console.error("[health-alert] Redis delivery lease unavailable", safeErrorLabel(error));
    if (!isPage) return "failed";
    return deliverPageWithoutRedis(alert.key, token, webhookUrl, alert, cooldownMs, nowMs);
  }
  if (acquired !== "OK") return "suppressed";

  if (isPage && !claimLocalPage(alert.key, token, nowMs)) return "suppressed";

  if (await deliverDiscordAlert(webhookUrl, alert, nowMs)) {
    // Record the local cooldown before promotion so a degraded peer sees this
    // delivery whether or not Redis keeps the lease.
    if (isPage) completeLocalPage(alert.key, token, cooldownMs, nowMs);
    try {
      const promoted = await withRedisTimeout(
        "alert promotion",
        redis.eval(PROMOTE_OWNED_LEASE, 1, redisKey, token, String(cooldownMs)),
      );
      if (promoted === 1 || promoted === "OK") return "sent";
      return "sent-degraded";
    } catch (error) {
      console.error("[health-alert] Failed to promote delivery lease", safeErrorLabel(error));
      return "sent-degraded";
    }
  }

  if (isPage) releaseLocalPage(alert.key, token);
  try {
    await withRedisTimeout("alert lease release", redis.eval(DELETE_OWNED_LEASE, 1, redisKey, token));
  } catch (error) {
    console.error("[health-alert] Failed to release delivery lease", safeErrorLabel(error));
  }
  return "failed";
}
