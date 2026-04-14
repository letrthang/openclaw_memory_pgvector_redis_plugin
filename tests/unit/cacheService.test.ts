// ─── Unit tests: cache service key building and fail-open pattern ───

// Mock config before importing cacheService
jest.mock('../../src/config/env', () => ({
  config: {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    EMBEDDING_PROVIDER: 'anthropic',
    EMBEDDING_API_KEY: 'test-key',
    EMBEDDING_MODEL: 'claude-haiku-4.5',
    TENANCY_NAME: 'TEST',
    DB_TABLE_NAME: 'v1.openclaw_agent_memory',
    REDIS_KEY_PREFIX: 'openclaw:memory',
  },
}));
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock('../../src/cache/redisClient', () => ({
  getClient: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
    scan: jest.fn(),
    del: jest.fn(),
  })),
}));

import { buildKey } from '../../src/cache/cacheService';

describe('buildKey', () => {
  test('builds key with single segment', () => {
    const key = buildKey('T1', 'long_term');
    expect(key).toBe('openclaw:memory:T1:long_term');
  });

  test('builds key with multiple segments', () => {
    const key = buildKey('T1', 'search', 'abc123');
    expect(key).toBe('openclaw:memory:T1:search:abc123');
  });

  test('builds key with daily note segment', () => {
    const key = buildKey('COMPANY', 'daily', '2026-04-14');
    expect(key).toBe('openclaw:memory:COMPANY:daily:2026-04-14');
  });

  test('builds key with session segment', () => {
    const key = buildKey('T1', 'session', 'session-uuid-123');
    expect(key).toBe('openclaw:memory:T1:session:session-uuid-123');
  });

  test('key segments are joined by colons', () => {
    const key = buildKey('T1', 'search', 'hash123');
    const parts = key.split(':');
    expect(parts).toEqual(['openclaw', 'memory', 'T1', 'search', 'hash123']);
  });
});

