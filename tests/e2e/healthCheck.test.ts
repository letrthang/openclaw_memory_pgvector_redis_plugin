// ─── E2E tests: healthCheck response format ───

import { getHealthStatus } from '../../src/health/healthCheck';
import * as pool from '../../src/db/pool';
import * as redisClient from '../../src/cache/redisClient';
import * as embeddingService from '../../src/embedding/embeddingService';

// Mock dependencies
jest.mock('../../src/db/pool');
jest.mock('../../src/cache/redisClient');
jest.mock('../../src/embedding/embeddingService');
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

const mockedPool = pool as jest.Mocked<typeof pool>;
const mockedRedis = redisClient as jest.Mocked<typeof redisClient>;
const mockedEmbedding = embeddingService as jest.Mocked<typeof embeddingService>;

describe('getHealthStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedEmbedding.getProviderInfo.mockReturnValue({
      name: 'anthropic',
      model: 'claude-haiku-4.5',
      dimensions: 1536,
    });
  });

  test('both connected: returns healthy', async () => {
    mockedPool.healthCheck.mockResolvedValue(true);
    mockedRedis.healthCheck.mockResolvedValue(true);

    const status = await getHealthStatus();

    expect(status.status).toBe('healthy');
    expect(status.postgresql).toBe('connected');
    expect(status.redis).toBe('connected');
    expect(status.plugin).toBe('memory-pgvector-redis');
    expect(status.tenancy).toBe('TEST');
    expect(status.embedding.name).toBe('anthropic');
    expect(status.embedding.model).toBe('claude-haiku-4.5');
    expect(status.embedding.dimensions).toBe(1536);
  });

  test('PG down: returns degraded', async () => {
    mockedPool.healthCheck.mockResolvedValue(false);
    mockedRedis.healthCheck.mockResolvedValue(true);

    const status = await getHealthStatus();

    expect(status.status).toBe('degraded');
    expect(status.postgresql).toBe('disconnected');
    expect(status.redis).toBe('connected');
  });

  test('Redis down: returns degraded', async () => {
    mockedPool.healthCheck.mockResolvedValue(true);
    mockedRedis.healthCheck.mockResolvedValue(false);

    const status = await getHealthStatus();

    expect(status.status).toBe('degraded');
    expect(status.postgresql).toBe('connected');
    expect(status.redis).toBe('disconnected');
  });

  test('both down: returns unhealthy', async () => {
    mockedPool.healthCheck.mockResolvedValue(false);
    mockedRedis.healthCheck.mockResolvedValue(false);

    const status = await getHealthStatus();

    expect(status.status).toBe('unhealthy');
    expect(status.postgresql).toBe('disconnected');
    expect(status.redis).toBe('disconnected');
  });

  test('response includes version field', async () => {
    mockedPool.healthCheck.mockResolvedValue(true);
    mockedRedis.healthCheck.mockResolvedValue(true);

    const status = await getHealthStatus();

    expect(status.version).toBeDefined();
    expect(typeof status.version).toBe('string');
  });
});

