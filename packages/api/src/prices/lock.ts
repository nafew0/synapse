import { logger } from '@librechat/data-schemas';
import { ioredisClient } from '~/cache/redisClients';
import { cacheConfig } from '~/cache/cacheConfig';

/** The two Redis calls the lock needs; `ioredis` provides both. */
export interface RedisLockClient {
  set: (key: string, value: string, ex: 'EX', seconds: number, nx: 'NX') => Promise<string | null>;
  eval: (script: string, keys: number, key: string, value: string) => Promise<unknown>;
}

export interface Lock {
  acquired: boolean;
  release: () => Promise<void>;
}

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;
const NOT_HELD: Lock = { acquired: false, release: async () => undefined };
const ALWAYS_HELD: Lock = { acquired: true, release: async () => undefined };

/**
 * Lets one server run a job. With Redis it is `SET NX EX`, released only by its owner; without Redis
 * (a single instance) the caller always holds it. A Redis error counts as not held: a skipped run is
 * harmless, two concurrent ones are not.
 */
export async function acquireLock(
  key: string,
  ttlSeconds: number,
  client: RedisLockClient | null | undefined = cacheConfig.USE_REDIS
    ? (ioredisClient as unknown as RedisLockClient | undefined)
    : null,
): Promise<Lock> {
  if (!client) {
    return ALWAYS_HELD;
  }
  const owner = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  try {
    const result = await client.set(key, owner, 'EX', ttlSeconds, 'NX');
    if (result !== 'OK') {
      return NOT_HELD;
    }
  } catch (error) {
    logger.error(`[ModelPrice] lock ${key} failed`, error);
    return NOT_HELD;
  }
  return {
    acquired: true,
    release: async () => {
      try {
        await client.eval(RELEASE, 1, key, owner);
      } catch (error) {
        logger.error(`[ModelPrice] releasing lock ${key} failed`, error);
      }
    },
  };
}
