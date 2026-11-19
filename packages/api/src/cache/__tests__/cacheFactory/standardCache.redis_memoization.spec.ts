import type { EventEmitter } from 'events';

jest.mock('../../redisClients', () => {
  const { EventEmitter } = jest.requireActual<typeof import('events')>('events');
  return {
    keyvRedisClient: Object.assign(new EventEmitter(), { connect: jest.fn() }),
    ioredisClient: null,
  };
});

jest.mock('../../cacheConfig', () => ({
  cacheConfig: {
    FORCED_IN_MEMORY_CACHE_NAMESPACES: [],
    REDIS_KEY_PREFIX: '',
    GLOBAL_PREFIX_SEPARATOR: '>>',
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import { standardCache, tokenConfigCache } from '../../cacheFactory';
import { keyvRedisClient } from '../../redisClients';

const CLIENT_EVENTS = ['connect', 'disconnect', 'reconnecting'];

const listenerCounts = () =>
  CLIENT_EVENTS.map((event) => (keyvRedisClient as EventEmitter).listenerCount(event));

describe('standardCache - Redis memoization', () => {
  it('adds no client listeners when the same namespace and TTL are requested again', () => {
    const first = tokenConfigCache();
    const countsAfterFirstCall = listenerCounts();

    const repeats = Array.from({ length: 100 }, () => tokenConfigCache());

    expect(repeats.every((cache) => cache === first)).toBe(true);
    expect(listenerCounts()).toEqual(countsAfterFirstCall);
  });

  it('keeps separate instances for different namespaces', () => {
    expect(standardCache('ns-one', 1000)).not.toBe(standardCache('ns-two', 1000));
  });

  it('keeps separate instances for different TTLs in one namespace', () => {
    const short = standardCache('ns-ttl', 1000);
    const long = standardCache('ns-ttl', 2000);

    expect(short).not.toBe(long);
    expect(short.ttl).toBe(1000);
    expect(long.ttl).toBe(2000);
  });
});
