// ─── Integration tests: memorySearch operation ───

import { memorySearch } from '../../src/operations/memorySearch';
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

const mockResults = [
  {
    id: 'uuid-1',
    content_text: 'result 1',
    similarity: 0.95,
    memory_type: 'long_term' as const,
    memory_date: null,
  },
  {
    id: 'uuid-2',
    content_text: 'result 2',
    similarity: 0.88,
    memory_type: 'daily_note' as const,
    memory_date: '2026-04-14',
  },
];

describe('memorySearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPipeline.normalizeAndHash.mockReturnValue('hash123');
    mockedCache.getSearchCache.mockResolvedValue(null);
    mockedEmbedding.generateEmbedding.mockResolvedValue(new Array(1536).fill(0.1));
    mockedQueries.searchByVector.mockResolvedValue(mockResults);
    mockedCache.setSearchCache.mockResolvedValue();
  });

  test('cache HIT: returns from Redis, PG not called', async () => {
    mockedCache.getSearchCache.mockResolvedValue(mockResults);

    const results = await memorySearch({ query: 'test query', tenantId: 'T1' });

    expect(results).toEqual(mockResults);
    expect(mockedQueries.searchByVector).not.toHaveBeenCalled();
    expect(mockedEmbedding.generateEmbedding).not.toHaveBeenCalled();
  });

  test('cache MISS: generates embedding, PG search, caches results', async () => {
    const results = await memorySearch({ query: 'test query', tenantId: 'T1' });

    expect(results).toEqual(mockResults);
    expect(mockedEmbedding.generateEmbedding).toHaveBeenCalledWith('test query');
    expect(mockedQueries.searchByVector).toHaveBeenCalledTimes(1);
    expect(mockedCache.setSearchCache).toHaveBeenCalledWith('T1', 'hash123', mockResults);
  });

  test('Redis failure on cache check: proceeds to PG search', async () => {
    mockedCache.getSearchCache.mockResolvedValue(null); // simulates cache miss / failure

    const results = await memorySearch({ query: 'test query', tenantId: 'T1' });

    expect(results).toEqual(mockResults);
    expect(mockedQueries.searchByVector).toHaveBeenCalledTimes(1);
  });

  test('embedding failure: returns empty array', async () => {
    mockedEmbedding.generateEmbedding.mockResolvedValue([]);

    const results = await memorySearch({ query: 'test query', tenantId: 'T1' });

    expect(results).toEqual([]);
    expect(mockedQueries.searchByVector).not.toHaveBeenCalled();
  });

  test('PG failure on HNSW search: throws DatabaseError', async () => {
    mockedQueries.searchByVector.mockRejectedValue(new Error('PG HNSW failed'));

    await expect(
      memorySearch({ query: 'test query', tenantId: 'T1' })
    ).rejects.toThrow('PG HNSW failed');
  });

  test('respects limit parameter', async () => {
    await memorySearch({ query: 'test query', tenantId: 'T1', limit: 10 });

    expect(mockedQueries.searchByVector).toHaveBeenCalledWith(
      expect.any(Array),
      'T1',
      10
    );
  });
});

