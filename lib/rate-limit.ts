import prisma from "./prisma";

const WALLET_WINDOW_MS = 15_000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const EXPORT_WINDOW_MS = 60_000;
const EXPORT_MAX_REQUESTS = 5;

function lockKey(prefix: string, key: string): string {
  return `rate_limit:${prefix}:${key}`;
}

let bucketsEnsured = false;

type PrismaClientLike = Pick<typeof prisma, "$executeRaw">;

async function ensureRateLimitBuckets(client: PrismaClientLike): Promise<void> {
  if (bucketsEnsured) return;
  await client.$executeRaw`
    CREATE UNLOGGED TABLE IF NOT EXISTS rate_limit_buckets (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key        TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '60 seconds')
    )
  `;
  await client.$executeRaw`
    CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_key_expires
      ON rate_limit_buckets (key, expires_at)
  `;
  bucketsEnsured = true;
}

/** At most `max` requests per key within any `windowMs`. */
export interface RateLimit {
  max: number;
  windowMs: number;
}

/** One request every 15s: the original wallet throttle, and the default. */
const WALLET_LIMIT: RateLimit = { max: 1, windowMs: WALLET_WINDOW_MS };

/**
 * A small burst for flows a contributor legitimately repeats within seconds:
 * declining a Freighter prompt and trying again, reloading mid-setup, or the
 * payout-setup rebuild after `retry`.
 */
export const WALLET_BURST_LIMIT: RateLimit = { max: 5, windowMs: 60_000 };

export type RateLimitDecision =
  | { limited: false }
  /** `retryAfterSeconds`: until the oldest request in the window expires. */
  | { limited: true; retryAfterSeconds: number };

/** Record one request against `bucketKey` unless it is already at `limit`. */
export async function takeRateLimit(bucketKey: string, limit: RateLimit): Promise<RateLimitDecision> {
  return prisma.$transaction(async (tx) => {
    await ensureRateLimitBuckets(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey("wallet", bucketKey)}))`;

    await tx.$executeRaw`
      DELETE FROM rate_limit_buckets
      WHERE key = ${bucketKey} AND expires_at < NOW()
    `;

    const rows = await tx.$queryRaw<Array<{ count: bigint; retry_after: bigint | null }>>`
      SELECT COUNT(*)::int8 AS count,
             CEIL(EXTRACT(EPOCH FROM (MIN(expires_at) - NOW())))::int8 AS retry_after
      FROM rate_limit_buckets WHERE key = ${bucketKey}
    `;

    if (Number(rows[0].count) >= limit.max) {
      return { limited: true, retryAfterSeconds: Math.max(1, Number(rows[0].retry_after ?? 1)) };
    }

    await tx.$executeRaw`
      INSERT INTO rate_limit_buckets (key, expires_at)
      VALUES (${bucketKey}, NOW() + make_interval(secs => ${limit.windowMs}::int / 1000.0))
    `;

    return { limited: false };
  });
}

/** True when `bucketKey` is over `limit`; otherwise records the request. */
export async function checkWalletRateLimit(bucketKey: string, limit: RateLimit = WALLET_LIMIT): Promise<boolean> {
  return (await takeRateLimit(bucketKey, limit)).limited;
}

const LOGIN_PREFIX = "login:";

export async function isLoginRateLimited(ip: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await ensureRateLimitBuckets(tx);
    const key = LOGIN_PREFIX + ip;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey("login", ip)}))`;

    await tx.$executeRaw`
      DELETE FROM rate_limit_buckets
      WHERE key = ${key} AND expires_at < NOW()
    `;

    const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::int8 as count FROM rate_limit_buckets WHERE key = ${key}
    `;

    return Number(rows[0].count) >= LOGIN_MAX_FAILURES;
  });
}

export async function recordLoginFailure(ip: string): Promise<void> {
  const key = LOGIN_PREFIX + ip;
  await ensureRateLimitBuckets(prisma);
  await prisma.$executeRaw`
    INSERT INTO rate_limit_buckets (key, expires_at)
    VALUES (${key}, NOW() + make_interval(secs => ${LOGIN_WINDOW_MS}::int / 1000.0))
  `;
}

export async function resetLoginFailures(ip: string): Promise<void> {
  const key = LOGIN_PREFIX + ip;
  await ensureRateLimitBuckets(prisma);
  await prisma.$executeRaw`
    DELETE FROM rate_limit_buckets WHERE key = ${key}
  `;
}

export async function checkExportRateLimit(adminUserId: string): Promise<boolean> {
  const key = `export:${adminUserId}`;
  return prisma.$transaction(async (tx) => {
    await ensureRateLimitBuckets(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey("export", adminUserId)}))`;

    await tx.$executeRaw`
      DELETE FROM rate_limit_buckets
      WHERE key = ${key} AND expires_at < NOW()
    `;

    const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::int8 as count FROM rate_limit_buckets WHERE key = ${key}
    `;

    if (Number(rows[0].count) >= EXPORT_MAX_REQUESTS) {
      return true;
    }

    await tx.$executeRaw`
      INSERT INTO rate_limit_buckets (key, expires_at)
      VALUES (${key}, NOW() + make_interval(secs => ${EXPORT_WINDOW_MS}::int / 1000.0))
    `;

    return false;
  });
}
