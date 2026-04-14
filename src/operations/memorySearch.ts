// ─── memory_search operation — semantic search with Redis caching ───

import crypto from 'crypto';
import * as queries from '../db/queries.js';
import * as cacheService from '../cache/cacheService.js';
import { generateEmbedding } from '../embedding/embeddingService.js';
import { normalizeAndHash } from '../normalization/pipeline.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/env.js';
import type { SearchParams, MemoryResult } from '../types/index.js';

/**
 * Search memories by semantic similarity — the full read path.
 *
 * Steps:
 * 1. Normalize query → SHA-256 hash (cache key)
 * 2. Check Redis cache → if HIT, return immediately (~1ms)
 * 3. On MISS, generate embedding for the query
 * 4. pgvector HNSW similarity search on PostgreSQL
 * 5. Cache results in Redis (TTL 5m)
 * 6. Return top-K results
 */
export async function memorySearch(params: SearchParams): Promise<MemoryResult[]> {
  const { query, tenantId, limit = 5 } = params;

  // Step 0: Input validation
  if (!query || query.length === 0) {
    logger.warn('memorySearch: empty query, returning empty results');
    return [];
  }
  if (query.length > config.MAX_CONTENT_LENGTH) {
    logger.warn(`memorySearch: query exceeds max length (${query.length}), truncating`);
  }

  // Step 1: Normalize query
  let normalizedHash: string;
  try {
    normalizedHash = normalizeAndHash(query);
  } catch {
    normalizedHash = crypto.createHash('sha256').update(query).digest('hex');
    logger.warn('Normalization failed, using raw hash');
  }

  // Step 2: Check Redis cache
  const cached = await cacheService.getSearchCache(tenantId, normalizedHash);
  if (cached) {
    logger.debug('Search cache HIT');
    return cached; // fast path (~1ms)
  }

  // Step 3: Generate query embedding
  const embedding = await generateEmbedding(query);
  if (embedding.length === 0) {
    logger.warn('Query embedding failed, returning empty results');
    return [];
  }

  // Step 4: pgvector HNSW search
  const results = await queries.searchByVector(embedding, tenantId, limit);

  // Step 5: Cache results in Redis (fire-and-forget)
  void cacheService.setSearchCache(tenantId, normalizedHash, results).catch((err) =>
    logger.warn('Redis SET (search cache) fire-and-forget failed', err)
  );

  // Step 6: Return results
  return results;
}

