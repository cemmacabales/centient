import Redis from "ioredis";

const globalForRedis = globalThis as unknown as {
  __redis: Redis | undefined;
};

export const redis =
  globalForRedis.__redis ??
  (() => {
    const url = process.env.REDIS_URL;
    if (!url) {
      // No URL configured — create a stub that won't spam connection errors.
      // Any Redis command will fail immediately rather than queuing indefinitely.
      return new Redis({
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
    }
    const instance = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 1000);
      },
      lazyConnect: true,
    });
    if (process.env.NODE_ENV !== "production") {
      globalForRedis.__redis = instance;
    }
    return instance;
  })();
