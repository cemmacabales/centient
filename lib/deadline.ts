const DEFAULT_REDIS_OPERATION_TIMEOUT_MS = 2_000;

/**
 * A Redis command that outlives its deadline is abandoned, never awaited again,
 * and may still apply on the server. Every bounded call site must therefore be
 * safe to abandon: alert leases carry their own PX expiry, and the refill timer
 * refuses to issue a newer command until the abandoned one settles.
 */
export class OperationTimeoutError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`Redis ${operation} did not settle before its deadline`);
    this.name = "OperationTimeoutError";
    this.operation = operation;
  }
}

/** Configured bound for a single Redis command, in milliseconds. */
export function redisOperationTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = Number(env.REDIS_OPERATION_TIMEOUT_MS ?? DEFAULT_REDIS_OPERATION_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_REDIS_OPERATION_TIMEOUT_MS;
}

/**
 * Bound an already-issued operation. The work is NOT cancelled on timeout — the
 * caller stops waiting, so every call site must be safe to abandon.
 */
export function withDeadline<T>(
  operation: string,
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OperationTimeoutError(operation)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Bound an already-issued Redis command with the configured Redis deadline. */
export function withRedisTimeout<T>(
  operation: string,
  command: Promise<T>,
  timeoutMs: number = redisOperationTimeoutMs(),
): Promise<T> {
  return withDeadline(operation, command, timeoutMs);
}
