// ─── Plugin entry point — initializes all subsystems and exports public API ───

import { config } from './config/env.js';
import { initPool, shutdown as shutdownPool, query } from './db/pool.js';
import { connectRedis, shutdown as shutdownRedis } from './cache/redisClient.js';
import { initEmbeddingService, getProviderInfo, getDimensions } from './embedding/embeddingService.js';
import { loadDictionaries } from './normalization/spellCorrector.js';
import { logger } from './utils/logger.js';

// Re-export public API
export { memorySave } from './operations/memorySave.js';
export { memorySearch } from './operations/memorySearch.js';
export { startupLoad } from './operations/startupLoad.js';
export { getHealthStatus } from './health/healthCheck.js';

// Re-export types
export type {
  MemoryType,
  MemoryRow,
  MemoryResult,
  MemoryContext,
  HealthResponse,
  SaveParams,
  SaveResult,
  SearchParams,
  StartupParams,
  EmbeddingProviderInfo,
} from './types/index.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json');

/**
 * Initialize the plugin — must be called before any operations.
 */
export async function initialize(): Promise<void> {
  // 1. Config is already validated on import (env.ts)
  logger.info(`Initializing memory-pgvector-redis@${version}...`);

  // 2. Initialize PostgreSQL pool
  await initPool();

  // 3. Connect to Redis
  await connectRedis();

  // 4. Initialize embedding service
  initEmbeddingService();

  // 5. Validate embedding dimensions vs DB schema
  await validateEmbeddingDimensions();

  // 6. Load Hunspell dictionaries
  await loadDictionaries();

  // 7. Startup banner
  const provider = getProviderInfo();
  logger.info(
    `memory-pgvector-redis@${version} initialized — tenancy=${config.TENANCY_NAME}, table=${config.DB_TABLE_NAME}, embedding=${provider.name}/${provider.model}`
  );
}

/**
 * Graceful shutdown — drain connections and close all subsystems.
 */
export async function shutdown(): Promise<void> {
  logger.info('Shutting down...');
  await shutdownPool();
  await shutdownRedis();
  logger.info('Shutdown complete');
}

/**
 * Validate that embedding provider dimensions match any existing data in the DB.
 * Logs a warning if there's a mismatch — does NOT block startup.
 */
async function validateEmbeddingDimensions(): Promise<void> {
  const providerDims = getDimensions();
  if (providerDims === 0) return;

  try {
    const result = await query<{ dim: number }>(
      `SELECT vector_dims(embedding) AS dim FROM ${config.DB_TABLE_NAME} WHERE embedding IS NOT NULL LIMIT 1`
    );
    if (result.rows.length > 0) {
      const dbDim = result.rows[0].dim;
      if (dbDim !== providerDims) {
        logger.warn(
          `⚠ Embedding dimension mismatch: DB has ${dbDim}-dim vectors, but provider reports ${providerDims} dims. ` +
          `This will cause INSERT failures. Consider migrating the embedding column or switching providers.`
        );
      } else {
        logger.info(`Embedding dimensions validated: ${dbDim}d (matches provider)`);
      }
    }
  } catch (err) {
    logger.warn('Could not validate embedding dimensions (table may not exist yet)', err);
  }
}

// Register signal handlers for graceful shutdown
const SHUTDOWN_TIMEOUT_MS = 10_000;

process.on('SIGTERM', () => {
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  void shutdown().then(() => process.exit(0));
});

process.on('SIGINT', () => {
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  void shutdown().then(() => process.exit(0));
});

