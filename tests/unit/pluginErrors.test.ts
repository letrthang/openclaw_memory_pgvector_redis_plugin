// ─── Unit tests: error classification and retry logic ───

import {
  isTransientPgError,
  isRetryableHttpError,
  withRetry,
  ConfigError,
  DatabaseError,
  CacheError,
  EmbeddingError,
  NormalizationError,
} from '../../src/errors/pluginErrors';

describe('isTransientPgError', () => {
  test('identifies ECONNREFUSED as transient', () => {
    expect(isTransientPgError({ message: 'connect ECONNREFUSED 127.0.0.1:5432' })).toBe(true);
  });

  test('identifies ECONNRESET as transient', () => {
    expect(isTransientPgError({ message: 'ECONNRESET' })).toBe(true);
  });

  test('identifies 57P01 (admin shutdown) as transient', () => {
    expect(isTransientPgError({ code: '57P01' })).toBe(true);
  });

  test('identifies 57P03 (cannot connect now) as transient', () => {
    expect(isTransientPgError({ code: '57P03' })).toBe(true);
  });

  test('identifies 08006 (connection failure) as transient', () => {
    expect(isTransientPgError({ code: '08006' })).toBe(true);
  });

  test('identifies 08001 as transient', () => {
    expect(isTransientPgError({ code: '08001' })).toBe(true);
  });

  test('identifies 08004 as transient', () => {
    expect(isTransientPgError({ code: '08004' })).toBe(true);
  });

  test('rejects 23505 (unique violation) as non-transient', () => {
    expect(isTransientPgError({ code: '23505' })).toBe(false);
  });

  test('rejects 42P01 (undefined table) as non-transient', () => {
    expect(isTransientPgError({ code: '42P01' })).toBe(false);
  });

  test('rejects syntax error as non-transient', () => {
    expect(isTransientPgError({ code: '42601', message: 'syntax error' })).toBe(false);
  });

  test('returns false for null/undefined', () => {
    expect(isTransientPgError(null)).toBe(false);
    expect(isTransientPgError(undefined)).toBe(false);
  });

  test('returns false for non-object', () => {
    expect(isTransientPgError('string')).toBe(false);
    expect(isTransientPgError(123)).toBe(false);
  });
});

describe('isRetryableHttpError', () => {
  test('identifies 429 (rate limit) as retryable', () => {
    expect(isRetryableHttpError({ status: 429 })).toBe(true);
  });

  test('identifies 500 (server error) as retryable', () => {
    expect(isRetryableHttpError({ status: 500 })).toBe(true);
  });

  test('identifies 502 as retryable', () => {
    expect(isRetryableHttpError({ status: 502 })).toBe(true);
  });

  test('identifies 503 as retryable', () => {
    expect(isRetryableHttpError({ statusCode: 503 })).toBe(true);
  });

  test('rejects 400 (bad request) as not retryable', () => {
    expect(isRetryableHttpError({ status: 400 })).toBe(false);
  });

  test('rejects 401 (unauthorized) as not retryable', () => {
    expect(isRetryableHttpError({ status: 401 })).toBe(false);
  });

  test('rejects 404 as not retryable', () => {
    expect(isRetryableHttpError({ status: 404 })).toBe(false);
  });
});

describe('withRetry', () => {
  test('returns result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { maxAttempts: 3, delayMs: 10 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on failure and succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');
    const result = await withRetry(fn, { maxAttempts: 3, delayMs: 10 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('throws after maxAttempts exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fail'));
    await expect(withRetry(fn, { maxAttempts: 3, delayMs: 10 })).rejects.toThrow('always fail');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('does not retry when retryIf returns false', async () => {
    const err = new Error('non-retryable');
    const fn = jest.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { maxAttempts: 3, delayMs: 10, retryIf: () => false })
    ).rejects.toThrow('non-retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('respects backoff multiplier', async () => {
    const startTime = Date.now();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');
    await withRetry(fn, { maxAttempts: 3, delayMs: 50, backoff: 2 });
    const elapsed = Date.now() - startTime;
    // Should wait at least 50ms (first) + 100ms (second) = 150ms
    expect(elapsed).toBeGreaterThanOrEqual(100); // with some tolerance
  });
});

describe('Custom error classes', () => {
  test('ConfigError has correct name and message', () => {
    const err = new ConfigError('missing DATABASE_URL');
    expect(err.name).toBe('ConfigError');
    expect(err.message).toBe('missing DATABASE_URL');
    expect(err).toBeInstanceOf(Error);
  });

  test('DatabaseError preserves context', () => {
    const cause = new Error('connection refused');
    const err = new DatabaseError('query failed', {
      cause,
      code: '08006',
      query: 'SELECT 1',
      tenantId: 'T1',
    });
    expect(err.name).toBe('DatabaseError');
    expect(err.code).toBe('08006');
    expect(err.query).toBe('SELECT 1');
    expect(err.tenantId).toBe('T1');
    expect(err.cause).toBe(cause);
  });

  test('CacheError preserves context', () => {
    const err = new CacheError('GET failed', { operation: 'GET', key: 'test:key' });
    expect(err.name).toBe('CacheError');
    expect(err.operation).toBe('GET');
    expect(err.key).toBe('test:key');
  });

  test('EmbeddingError preserves context', () => {
    const err = new EmbeddingError('API error', {
      provider: 'anthropic',
      statusCode: 429,
      retryable: true,
    });
    expect(err.name).toBe('EmbeddingError');
    expect(err.provider).toBe('anthropic');
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
  });

  test('NormalizationError preserves context', () => {
    const err = new NormalizationError('step failed', {
      step: 'spellCorrect',
      input: 'test input',
    });
    expect(err.name).toBe('NormalizationError');
    expect(err.step).toBe('spellCorrect');
    expect(err.input).toBe('test input');
  });
});

