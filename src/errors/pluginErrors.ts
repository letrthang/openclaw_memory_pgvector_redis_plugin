// ─── Custom error classes for structured error handling ───

import type { RetryOptions } from '../types/index.js';

// ─── Transient PostgreSQL error codes ───
const TRANSIENT_PG_CODES = new Set([
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
]);

const TRANSIENT_MSG_PATTERNS = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'];

// ─── Custom Error Classes ───

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class DatabaseError extends Error {
  public readonly code?: string;
  public readonly query?: string;
  public readonly tenantId?: string;

  constructor(message: string, options?: { cause?: Error; code?: string; query?: string; tenantId?: string }) {
    super(message, { cause: options?.cause });
    this.name = 'DatabaseError';
    this.code = options?.code;
    this.query = options?.query;
    this.tenantId = options?.tenantId;
  }
}

export class CacheError extends Error {
  public readonly operation?: string;
  public readonly key?: string;

  constructor(message: string, options?: { cause?: Error; operation?: string; key?: string }) {
    super(message, { cause: options?.cause });
    this.name = 'CacheError';
    this.operation = options?.operation;
    this.key = options?.key;
  }
}

export class EmbeddingError extends Error {
  public readonly provider?: string;
  public readonly statusCode?: number;
  public readonly retryable?: boolean;

  constructor(message: string, options?: { cause?: Error; provider?: string; statusCode?: number; retryable?: boolean }) {
    super(message, { cause: options?.cause });
    this.name = 'EmbeddingError';
    this.provider = options?.provider;
    this.statusCode = options?.statusCode;
    this.retryable = options?.retryable;
  }
}

export class NormalizationError extends Error {
  public readonly step?: string;
  public readonly input?: string;

  constructor(message: string, options?: { cause?: Error; step?: string; input?: string }) {
    super(message, { cause: options?.cause });
    this.name = 'NormalizationError';
    this.step = options?.step;
    this.input = options?.input;
  }
}

// ─── Helper functions ───

/**
 * Check if a PostgreSQL error is transient (connection-level) and worth retrying.
 */
export function isTransientPgError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const pgErr = err as { code?: string; message?: string };

  if (pgErr.code && TRANSIENT_PG_CODES.has(pgErr.code)) {
    return true;
  }

  if (pgErr.message) {
    return TRANSIENT_MSG_PATTERNS.some((p) => pgErr.message!.includes(p));
  }

  return false;
}

/**
 * Check if an HTTP error is retryable (429, 500, 502, 503).
 */
export function isRetryableHttpError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const httpErr = err as { status?: number; statusCode?: number; message?: string };
  const code = httpErr.status ?? httpErr.statusCode;

  if (code && [429, 500, 502, 503].includes(code)) {
    return true;
  }

  if (httpErr.message) {
    return TRANSIENT_MSG_PATTERNS.some((p) => httpErr.message!.includes(p));
  }

  return false;
}

/**
 * Generic retry wrapper with configurable attempts, delay, and backoff.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { maxAttempts, delayMs, backoff = 2, retryIf } = opts;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // If retryIf predicate exists and says "don't retry", throw immediately
      if (retryIf && !retryIf(err)) {
        throw err;
      }

      if (attempt >= maxAttempts) {
        throw err;
      }

      const delay = delayMs * Math.pow(backoff, attempt - 1);
      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

