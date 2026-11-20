import type { RedisLockClient } from './lock';
import { acquireLock } from './lock';

/** Minimal in-memory Redis: SET NX EX plus the compare-and-delete release script. */
function createFakeRedis(): RedisLockClient & { store: Map<string, string>; evals: number } {
  const store = new Map<string, string>();
  const fake = {
    store,
    evals: 0,
    set: async (key: string, value: string, _ex: 'EX', _seconds: number, _nx: 'NX') => {
      if (store.has(key)) {
        return null;
      }
      store.set(key, value);
      return 'OK';
    },
    eval: async (_script: string, _keys: number, key: string, value: string) => {
      fake.evals += 1;
      if (store.get(key) === value) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  };
  return fake;
}

describe('acquireLock', () => {
  it('refuses a second holder until the first releases', async () => {
    const redis = createFakeRedis();
    const first = await acquireLock('job', 60, redis);
    expect(first.acquired).toBe(true);
    const second = await acquireLock('job', 60, redis);
    expect(second.acquired).toBe(false);
    await first.release();
    const third = await acquireLock('job', 60, redis);
    expect(third.acquired).toBe(true);
  });

  it('keeps separate keys independent', async () => {
    const redis = createFakeRedis();
    expect((await acquireLock('a', 60, redis)).acquired).toBe(true);
    expect((await acquireLock('b', 60, redis)).acquired).toBe(true);
  });

  it('lets only the owner release', async () => {
    const redis = createFakeRedis();
    const owner = await acquireLock('job', 60, redis);
    const loser = await acquireLock('job', 60, redis);
    await loser.release();
    expect(redis.store.has('job')).toBe(true);
    await owner.release();
    expect(redis.store.has('job')).toBe(false);
  });

  it('does not delete a lock another owner took after expiry', async () => {
    const redis = createFakeRedis();
    const stale = await acquireLock('job', 60, redis);
    redis.store.delete('job');
    const fresh = await acquireLock('job', 60, redis);
    expect(fresh.acquired).toBe(true);
    await stale.release();
    expect(redis.store.has('job')).toBe(true);
    expect((await acquireLock('job', 60, redis)).acquired).toBe(false);
  });

  it('is always acquired without a Redis client', async () => {
    const a = await acquireLock('job', 60, null);
    const b = await acquireLock('job', 60, null);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    await expect(a.release()).resolves.toBeUndefined();
  });

  it('counts a throwing client as not acquired', async () => {
    const broken: RedisLockClient = {
      set: async () => {
        throw new Error('connection lost');
      },
      eval: async () => 0,
    };
    expect((await acquireLock('job', 60, broken)).acquired).toBe(false);
  });

  it('swallows a failing release', async () => {
    const redis = createFakeRedis();
    const flaky: RedisLockClient = {
      set: redis.set,
      eval: async () => {
        throw new Error('gone');
      },
    };
    const lock = await acquireLock('job', 60, flaky);
    expect(lock.acquired).toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
