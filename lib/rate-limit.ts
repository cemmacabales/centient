import prisma from "./prisma";

const WALLET_WINDOW_MS = 15_000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const EXPORT_WINDOW_MS = 60_000;
const EXPORT_MAX_REQUESTS = 5;

function lockKey(prefix: string, key: string): string {
  return `rate_limit:${prefix}:${key}`;
}

export async function checkWalletRateLimit(wallet: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey("wallet", wallet)}))`;

    await tx.$executeRaw`
      DELETE FROM rate_limit_buckets
      WHERE key = ${wallet} AND expires_at < NOW()
    `;

    const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::int8 as count FROM rate_limit_buckets WHERE key = ${wallet}
    `;

    if (Number(rows[0].count) > 0) {
      return true;
    }

    await tx.$executeRaw`
      INSERT INTO rate_limit_buckets (key, expires_at)
      VALUES (${wallet}, NOW() + make_interval(ms := ${WALLET_WINDOW_MS}))
    `;

    return false;
  });
}

const LOGIN_PREFIX = "login:";

export async function isLoginRateLimited(ip: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
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
  await prisma.$executeRaw`
    INSERT INTO rate_limit_buckets (key, expires_at)
    VALUES (${key}, NOW() + make_interval(ms := ${LOGIN_WINDOW_MS}))
  `;
}

export async function resetLoginFailures(ip: string): Promise<void> {
  const key = LOGIN_PREFIX + ip;
  await prisma.$executeRaw`
    DELETE FROM rate_limit_buckets WHERE key = ${key}
  `;
}

export async function checkExportRateLimit(adminUserId: string): Promise<boolean> {
  const key = `export:${adminUserId}`;
  return prisma.$transaction(async (tx) => {
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
      VALUES (${key}, NOW() + make_interval(ms := ${EXPORT_WINDOW_MS}))
    `;

    return false;
  });
}
