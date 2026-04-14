// ─── Redis client wrapper with reconnect strategy and health probe ───

import Redis from 'ioredis';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

let redis: Redis;

/**
 * Create and connect the Redis client.
 */
export async function connectRedis(): Promise<void> {
  redis = new Redis(config.REDIS_URL, {
    retryStrategy(times: number): number | null {
      if (times > 20) {
        logger.error('Redis: max reconnect attempts (20) reached, giving up');
        return null; // stop retrying
      }
      return Math.min(times * 500, 30_000);
    },
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
  });

  // Event listeners
  redis.on('connect', () => logger.info('Redis connected'));
  redis.on('ready', () => logger.info('Redis ready'));
  redis.on('error', (err) => logger.error('Redis error', err));
  redis.on('close', () => logger.warn('Redis connection closed'));
  redis.on('reconnecting', () => logger.info('Redis reconnecting...'));

  try {
    await redis.connect();
  } catch (err) {
    logger.error('Redis initial connection failed (retryStrategy will handle)', err);
    // NOT fatal — retryStrategy will keep trying
  }
}

/**
 * Get the raw ioredis client instance.
 */
export function getClient(): Redis {
  return redis;
}

/**
 * Health check — PING with 2s timeout.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const result = await Promise.race([
      redis.ping(),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Redis PING timeout')), 2000)
      ),
    ]);
    return result === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown.
 */
export async function shutdown(): Promise<void> {
  try {
    await redis.quit();
    logger.info('Redis disconnected (quit)');
  } catch {
    redis.disconnect();
    logger.info('Redis disconnected (force)');
  }
}

