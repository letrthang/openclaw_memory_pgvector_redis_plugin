// ─── High-level Redis cache operations — fail-open pattern ───

import { getClient } from './redisClient.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { MemoryResult } from '../types/index.js';

// ─── TTL constants (seconds) ───
const SEARCH_TTL = 300;      // 5 minutes
const DAILY_TTL = 86_400;    // 24 hours
const SESSION_TTL = 3_600;   // 1 hour

/**
 * Build a structured Redis key.
 */
export function buildKey(tenantId: string, ...segments: string[]): string {
  return `${config.REDIS_KEY_PREFIX}:${tenantId}:${segments.join(':')}`;
}

// ─── Search Cache ───

export async function getSearchCache(tenantId: string, hash: string): Promise<MemoryResult[] | null> {
  try {
    const redis = getClient();
    const key = buildKey(tenantId, 'search', hash);
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as MemoryResult[];
  } catch (err) {
    logger.warn(`Redis GET (search cache) failed`, err);
    return null; // fail-open
  }
}

export async function setSearchCache(tenantId: string, hash: string, results: MemoryResult[]): Promise<void> {
  try {
    const redis = getClient();
    const key = buildKey(tenantId, 'search', hash);
    await redis.set(key, JSON.stringify(results), 'EX', SEARCH_TTL);
  } catch (err) {
    logger.warn(`Redis SET (search cache) failed`, err);
  }
}

/**
 * Evict all search cache keys for a tenant, optionally excluding one hash.
 * Uses SCAN (not KEYS *) to avoid blocking Redis.
 */
export async function evictSearchCache(tenantId: string, exceptHash?: string): Promise<void> {
  try {
    const redis = getClient();
    const pattern = buildKey(tenantId, 'search', '*');
    let cursor = '0';

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      const keysToDelete = exceptHash
        ? keys.filter((k) => !k.endsWith(exceptHash))
        : keys;

      if (keysToDelete.length > 0) {
        await redis.del(...keysToDelete);
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.warn('Search cache eviction failed', err);
  }
}

// ─── Long-Term Memory Cache ───

export async function getLongTerm(tenantId: string): Promise<string | null> {
  try {
    const redis = getClient();
    const key = buildKey(tenantId, 'long_term');
    return await redis.get(key);
  } catch (err) {
    logger.warn('Redis GET (long_term) failed', err);
    return null;
  }
}

export async function setLongTerm(tenantId: string, content: string): Promise<void> {
  try {
    const redis = getClient();
    const key = buildKey(tenantId, 'long_term');
    await redis.set(key, content); // no TTL — persistent
  } catch (err) {
    logger.warn('Redis SET (long_term) failed', err);
  }
}

// ─── Daily Note Cache ───

export async function getDaily(tenantId: string, date: string): Promise<string | null> {
  try {
    const redis = getClient();
    const key = buildKey(tenantId, 'daily', date);
    return await redis.get(key);
  } catch (err) {
    logger.warn('Redis GET (daily) failed', err);
    return null;
  }
}

export async function setDaily(tenantId: string, date: string, content: string): Promise<void> {
  try {
    const redis = getClient();
    const key = buildKey(tenantId, 'daily', date);
    await redis.set(key, content, 'EX', DAILY_TTL);
  } catch (err) {
    logger.warn('Redis SET (daily) failed', err);
  }
}

// ─── Session Cache ───

export async function getSession(tenantId: string, sessionId: string): Promise<string | null> {
  try {
    const redis = getClient();
    const key = buildKey(tenantId, 'session', sessionId);
    return await redis.get(key);
  } catch (err) {
    logger.warn('Redis GET (session) failed', err);
    return null;
  }
}

export async function setSession(tenantId: string, sessionId: string, content: string): Promise<void> {
  try {
    const redis = getClient();
    const key = buildKey(tenantId, 'session', sessionId);
    await redis.set(key, content, 'EX', SESSION_TTL);
  } catch (err) {
    logger.warn('Redis SET (session) failed', err);
  }
}

