import Redis from "ioredis";

const globalForRedis = globalThis as unknown as {
  __redis: Redis | undefined;
};

export const redis =
  globalForRedis.__redis ??
  (() => {
    const url = process.env.REDIS_URL;
    if (!url) {
      // ioredis accepts undefined URL; operations will fail gracefully
      return new Redis();
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
