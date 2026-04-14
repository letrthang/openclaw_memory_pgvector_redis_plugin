// ─── Health check handler — probes PostgreSQL and Redis connectivity ───

import * as pool from '../db/pool.js';
import * as redisClient from '../cache/redisClient.js';
import { getProviderInfo } from '../embedding/embeddingService.js';
import { config } from '../config/env.js';
import type { HealthResponse } from '../types/index.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../../package.json');

/**
 * Get current health status of all subsystems.
 * Runs PG and Redis health checks in parallel.
 */
export async function getHealthStatus(): Promise<HealthResponse> {
  const [pgOk, redisOk] = await Promise.all([
    pool.healthCheck(),
    redisClient.healthCheck(),
  ]);

  const status: HealthResponse['status'] =
    pgOk && redisOk ? 'healthy' :
    pgOk || redisOk ? 'degraded' :
    'unhealthy';

  return {
    plugin: 'memory-pgvector-redis',
    version,
    tenancy: config.TENANCY_NAME,
    status,
    postgresql: pgOk ? 'connected' : 'disconnected',
    redis: redisOk ? 'connected' : 'disconnected',
    embedding: getProviderInfo(),
  };
}

