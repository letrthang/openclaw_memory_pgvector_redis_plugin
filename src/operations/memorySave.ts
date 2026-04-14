// ─── memory_save operation — 6-step write path ───

import { v4 as uuidv4 } from 'uuid';
import * as queries from '../db/queries.js';
import * as cacheService from '../cache/cacheService.js';
import { generateEmbedding } from '../embedding/embeddingService.js';
import { normalizeAndHash } from '../normalization/pipeline.js';
import { DatabaseError } from '../errors/pluginErrors.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/env.js';
import type { SaveParams, SaveResult } from '../types/index.js';

/**
 * Helper: generate embedding and store in DB (fire-and-forget).
 */
async function generateAndStoreEmbedding(id: string, tenantId: string, content: string): Promise<void> {
  const embedding = await generateEmbedding(content);
  if (embedding.length === 0) return; // generation failed, already logged
  await queries.updateEmbedding(id, tenantId, embedding);
  logger.info(`Embedding stored for ${id}`);
}

/**
 * Save a memory entry — the full 6-step write path.
 *
 * Steps:
 * 1. Generate UUID
 * 2. PG upsert (source of truth) — HARD FAIL if this fails
 * 3. Normalize content for cache key
 * 4. Redis SET memory-type cache
 * 5. Redis search cache pre-warm + evict stale
 * 6. Async: generate embedding → store (fire-and-forget)
 */
export async function memorySave(params: SaveParams): Promise<SaveResult> {
  const { content, memoryType, tenantId, memoryDate, sessionId } = params;

  // Step 0: Input validation
  if (!content || content.length === 0) {
    throw new DatabaseError('memory_save: content must not be empty', { tenantId });
  }
  if (content.length > config.MAX_CONTENT_LENGTH) {
    throw new DatabaseError(
      `memory_save: content exceeds max length (${content.length} > ${config.MAX_CONTENT_LENGTH})`,
      { tenantId }
    );
  }

  // Step 1: Generate ID
  const id = uuidv4();

  // Step 2: PG upsert — HARD FAIL
  try {
    await queries.upsertMemory({
      id,
      tenant_id: tenantId,
      memory_type: memoryType,
      content_text: content,
      embedding: null,
      memory_date: memoryDate ?? null,
      status: 1,
    });
  } catch (err) {
    throw new DatabaseError('memory_save PG UPSERT failed', {
      cause: err as Error,
      tenantId,
    });
  }

  // Step 3: Normalize content (for cache pre-warm)
  let normalizedHash: string | null = null;
  try {
    normalizedHash = normalizeAndHash(content);
  } catch (err) {
    logger.warn('Normalization failed, skipping cache pre-warm', err);
  }

  // Step 4: Redis SET memory-type cache (fail-open)
  try {
    if (memoryType === 'long_term') {
      await cacheService.setLongTerm(tenantId, content);
    } else if (memoryType === 'daily_note' && memoryDate) {
      await cacheService.setDaily(tenantId, memoryDate, content);
    } else if (memoryType === 'session' && sessionId) {
      await cacheService.setSession(tenantId, sessionId, content);
    }
  } catch (err) {
    logger.warn('Redis SET (memory-type cache) failed', err);
  }

  // Step 5: Evict stale search cache for this tenant (fail-open)
  // Only evict — do NOT pre-warm with a single-item result that would pollute real search results.
  // The search cache will be naturally repopulated on the next memorySearch call.
  try {
    await cacheService.evictSearchCache(tenantId);
  } catch (err) {
    logger.warn('Redis search cache eviction failed', err);
  }

  // Step 6: Async embedding — fire and forget
  void generateAndStoreEmbedding(id, tenantId, content).catch((err) =>
    logger.error('Async embedding failed', err)
  );

  // Step 7: Return success
  return { id, tenantId, memoryType, status: 'saved' };
}

