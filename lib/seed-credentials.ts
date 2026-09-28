/**
 * Where the seed may fall back to a repository-literal password (ADR-0002).
 *
 * The literals in `prisma/seed.ts` are published and treated as burned. They
 * exist only so a fresh local database has a usable login. Anywhere else, the
 * seed must take the password from the environment or refuse, never create an
 * account under a value anyone reading the repository already knows.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

type SeedEnv = Readonly<Record<string, string | undefined>>;

/**
 * True only for a loopback database outside Railway. `railway run` and every
 * Railway deploy inject the RAILWAY_* identifiers, so a developer pointing a
 * local shell at a deployed database is not "local" either.
 */
export function isLocalDevelopment(env: SeedEnv): boolean {
  if (env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID) return false;
  if (!env.DATABASE_URL) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(env.DATABASE_URL).hostname);
  } catch {
    return false;
  }
}

/**
 * The password to seed `account` with: the environment value when set, the
 * local default on local development, and otherwise an error. The error names
 * the account and never the default, so a refused deploy log discloses nothing.
 */
export function resolveSeedPassword(opts: {
  account: string;
  envValue: string | undefined;
  localDefault: string;
  local: boolean;
}): string {
  if (opts.envValue?.trim()) return opts.envValue;
  if (opts.local) return opts.localDefault;
  throw new Error(
    `Refusing to seed ${opts.account} with the repository default password outside local development (ADR-0002). Set its password variable in this environment.`,
  );
}
