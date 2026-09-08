const DEFAULT_REDIS_OPERATION_TIMEOUT_MS = 2_000;

/**
 * A Redis command that outlives its deadline is abandoned, never awaited again,
 * and may still apply on the server. Every bounded call site must therefore be
 * safe to abandon: alert leases carry their own PX expiry, and the refill timer
 * refuses to issue a newer command until the abandoned one settles.
 */
export class RedisOperationTimeoutError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`Redis ${operation} did not settle before its deadline`);
    this.name = "RedisOperationTimeoutError";
    this.operation = operation;
  }
}

export function redisOperationTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = Number(env.REDIS_OPERATION_TIMEOUT_MS ?? DEFAULT_REDIS_OPERATION_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_REDIS_OPERATION_TIMEOUT_MS;
}

/** Bound an already-issued Redis command; `command` is not cancelled on timeout. */
export function withRedisTimeout<T>(
  operation: string,
  command: Promise<T>,
  timeoutMs: number = redisOperationTimeoutMs(),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RedisOperationTimeoutError(operation)), timeoutMs);
    command.then(
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
