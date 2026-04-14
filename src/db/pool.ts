// ─── PostgreSQL connection pool with retry, reconnection, and health check ───

import pg from 'pg';
import pgvector from 'pgvector/pg';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { DatabaseError, isTransientPgError, withRetry } from '../errors/pluginErrors.js';

const { Pool } = pg;

let pool: pg.Pool;
let connected = true;
let reconnecting: Promise<void> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff reconnection loop.
 * Attempts to reconnect up to 10 times with capped delay.
 */
async function reconnectLoop(): Promise<void> {
  const MAX_RECONNECT_ATTEMPTS = 10;
  const MAX_DELAY_MS = 30_000;

  for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), MAX_DELAY_MS);
    logger.info(`Reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`);
    await sleep(delay);

    let client: pg.PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      connected = true;
      reconnecting = null;
      logger.info(`Reconnected to PostgreSQL on attempt ${attempt}`);
      return;
    } catch (err) {
      if (client) {
        try { client.release(true); } catch { /* ignore */ }
      }
      logger.warn(`Reconnect attempt ${attempt} failed: ${(err as Error).message}`);
    }
  }

  logger.error('FATAL: Could not reconnect to PostgreSQL after 10 attempts — scheduling retry in 60s');
  reconnecting = null;

  // Schedule another reconnect attempt after a cooldown instead of permanent death
  setTimeout(() => {
    if (!connected && !reconnecting) {
      logger.info('Retrying PostgreSQL reconnection after cooldown...');
      reconnecting = reconnectLoop();
    }
  }, 60_000);
}

/**
 * Pool-level error handler — triggers reconnection on transient errors.
 */
function handlePoolError(err: Error): void {
  logger.error('PostgreSQL pool error', err);

  if (!isTransientPgError(err)) return;
  if (reconnecting) return; // already reconnecting

  connected = false;
  reconnecting = reconnectLoop();
}

/**
 * Initialize the PostgreSQL connection pool.
 */
export async function initPool(): Promise<void> {
  pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Register pgvector type
  await pgvector.registerType(pool);

  // Register pool-level error handler
  pool.on('error', handlePoolError);

  // Verify initial connection
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    connected = true;
    logger.info('PostgreSQL pool initialized (max=10)');
  } catch (err) {
    connected = false;
    logger.error('PostgreSQL initial connection failed', err);
    throw new DatabaseError('Failed to initialize PostgreSQL pool', { cause: err as Error });
  }
}

/**
 * Execute a SQL query with per-query retry for transient errors.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  // If disconnected and reconnecting, wait for reconnection
  if (!connected && reconnecting) {
    await reconnecting;
  }

  try {
    return await withRetry(
      () => pool.query<T>(text, params),
      {
        maxAttempts: 3,
        delayMs: 500,
        backoff: 2,
        retryIf: isTransientPgError,
      }
    );
  } catch (err) {
    throw new DatabaseError(`Query failed: ${text.substring(0, 80)}...`, {
      cause: err as Error,
      query: text,
    });
  }
}

/**
 * Get the raw pool for transaction support (e.g., BEGIN/COMMIT in queries.ts).
 */
export function getPool(): pg.Pool {
  return pool;
}

/**
 * Health check — runs SELECT 1 with a 3s timeout.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('PG health check timeout')), 3000)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown — drain active queries and close all connections.
 */
export async function shutdown(): Promise<void> {
  try {
    await pool.end();
    connected = false;
    logger.info('PostgreSQL pool closed');
  } catch (err) {
    logger.error('Error closing PostgreSQL pool', err);
  }
}

