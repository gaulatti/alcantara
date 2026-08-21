type ExpiringValue<T> = {
  value: T;
  expiresAt: string;
};

type CacheEntry<T> = {
  expiresAt?: number;
  promise: Promise<T>;
};

export function createExpiringSessionCache<T>(
  now: () => number = Date.now,
  refreshWindowMs = 30_000,
) {
  let cached: CacheEntry<T> | undefined;

  return {
    get(load: () => Promise<ExpiringValue<T>>): Promise<T> {
      if (cached && (cached.expiresAt === undefined || cached.expiresAt > now() + refreshWindowMs)) {
        return cached.promise;
      }

      const entry = {} as CacheEntry<T>;
      entry.promise = Promise.resolve()
        .then(load)
        .then(({ value, expiresAt }) => {
          const expiresAtMs = Date.parse(expiresAt);
          if (!Number.isFinite(expiresAtMs)) {
            throw new Error('Test session returned an invalid expiry');
          }
          entry.expiresAt = expiresAtMs;
          return value;
        })
        .catch((error: unknown) => {
          if (cached === entry) {
            cached = undefined;
          }
          throw error;
        });
      cached = entry;
      return entry.promise;
    },

    clear(): void {
      cached = undefined;
    },
  };
}
