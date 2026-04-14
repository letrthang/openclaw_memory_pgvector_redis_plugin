// ─── Integration tests: memorySave operation ───

import { memorySave } from '../../src/operations/memorySave';
import * as queries from '../../src/db/queries';
import * as cacheService from '../../src/cache/cacheService';
import * as embeddingService from '../../src/embedding/embeddingService';
import * as pipeline from '../../src/normalization/pipeline';

// Mock all external dependencies
jest.mock('../../src/db/queries');
jest.mock('../../src/cache/cacheService');
jest.mock('../../src/embedding/embeddingService');
jest.mock('../../src/normalization/pipeline');
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

const mockedQueries = queries as jest.Mocked<typeof queries>;
const mockedCache = cacheService as jest.Mocked<typeof cacheService>;
const mockedEmbedding = embeddingService as jest.Mocked<typeof embeddingService>;
const mockedPipeline = pipeline as jest.Mocked<typeof pipeline>;

describe('memorySave', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedQueries.upsertMemory.mockResolvedValue({
      id: 'test-uuid',
      tenant_id: 'T1',
      memory_type: 'long_term',
      content_text: 'test content',
      status: 1,
    });
    mockedPipeline.normalizeAndHash.mockReturnValue('hash123');
    mockedCache.setLongTerm.mockResolvedValue();
    mockedCache.setSearchCache.mockResolvedValue();
    mockedCache.evictSearchCache.mockResolvedValue();
    mockedEmbedding.generateEmbedding.mockResolvedValue(new Array(1536).fill(0.1));
    mockedQueries.updateEmbedding.mockResolvedValue();
  });

  test('happy path: saves to PG, updates Redis, fires embedding', async () => {
    const result = await memorySave({
      content: 'test content',
      memoryType: 'long_term',
      tenantId: 'T1',
    });

    expect(result.status).toBe('saved');
    expect(result.tenantId).toBe('T1');
    expect(result.memoryType).toBe('long_term');
    expect(result.id).toBeDefined();
    expect(mockedQueries.upsertMemory).toHaveBeenCalledTimes(1);
    expect(mockedCache.setLongTerm).toHaveBeenCalledWith('T1', 'test content');
  });

  test('PG failure: throws DatabaseError, Redis not called', async () => {
    mockedQueries.upsertMemory.mockRejectedValue(new Error('PG down'));

    await expect(
      memorySave({ content: 'test', memoryType: 'long_term', tenantId: 'T1' })
    ).rejects.toThrow('memory_save PG UPSERT failed');

    expect(mockedCache.setLongTerm).not.toHaveBeenCalled();
  });

  test('Redis failure on SET: logged, no throw, PG data intact', async () => {
    mockedCache.setLongTerm.mockRejectedValue(new Error('Redis down'));

    const result = await memorySave({
      content: 'test',
      memoryType: 'long_term',
      tenantId: 'T1',
    });

    expect(result.status).toBe('saved');
    expect(mockedQueries.upsertMemory).toHaveBeenCalledTimes(1);
  });

  test('normalization failure: logged, skip cache pre-warm', async () => {
    mockedPipeline.normalizeAndHash.mockImplementation(() => {
      throw new Error('normalization error');
    });

    const result = await memorySave({
      content: 'test',
      memoryType: 'long_term',
      tenantId: 'T1',
    });

    expect(result.status).toBe('saved');
    expect(mockedCache.setSearchCache).not.toHaveBeenCalled();
    expect(mockedCache.evictSearchCache).not.toHaveBeenCalled();
  });

  test('daily_note: sets daily cache with date', async () => {
    await memorySave({
      content: 'daily note content',
      memoryType: 'daily_note',
      tenantId: 'T1',
      memoryDate: '2026-04-14',
    });

    expect(mockedCache.setDaily).toHaveBeenCalledWith('T1', '2026-04-14', 'daily note content');
  });
});

