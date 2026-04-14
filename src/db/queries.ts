// ─── All parameterized SQL queries — centralized SQL, no strings scattered in ops ───

import { query, getPool } from './pool.js';
import { config } from '../config/env.js';
import { DatabaseError } from '../errors/pluginErrors.js';
import type { MemoryRow, MemoryResult } from '../types/index.js';

const TABLE = config.DB_TABLE_NAME;

// ─── Upsert Memory ───

export async function upsertMemory(row: Omit<MemoryRow, 'created_date' | 'updated_date'>): Promise<MemoryRow> {
  const sql = `
    INSERT INTO ${TABLE} (id, tenant_id, memory_type, content_text, embedding, memory_date, status, created_date, updated_date)
    VALUES ($1, $2, $3, $4, $5::vector, $6, $7, NOW(), NOW())
    ON CONFLICT (id, tenant_id) DO UPDATE SET
      content_text = EXCLUDED.content_text,
      embedding = EXCLUDED.embedding,
      memory_date = EXCLUDED.memory_date,
      status = EXCLUDED.status,
      updated_date = NOW()
    RETURNING *
  `;

  const params = [
    row.id,
    row.tenant_id,
    row.memory_type,
    row.content_text,
    row.embedding ?? null,
    row.memory_date ?? null,
    row.status,
  ];

  const result = await query<MemoryRow>(sql, params);
  return result.rows[0];
}

// ─── Vector Similarity Search (HNSW) ───

export async function searchByVector(
  embedding: number[],
  tenantId: string,
  limit: number = 5
): Promise<MemoryResult[]> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL hnsw.ef_search = 40');

    const sql = `
      SELECT id, content_text, memory_type, memory_date,
             1 - (embedding <=> $1::vector) AS similarity
      FROM ${TABLE}
      WHERE tenant_id = $2 AND status = 1
      ORDER BY embedding <=> $1::vector
      LIMIT $3
    `;

    const result = await client.query<MemoryResult>(sql, [
      JSON.stringify(embedding),
      tenantId,
      limit,
    ]);

    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore rollback error */ }
    throw new DatabaseError('searchByVector failed', { cause: err as Error, tenantId });
  } finally {
    client.release();
  }
}

// ─── Load Long-Term Memory ───

export async function loadLongTerm(
  tenantId: string
): Promise<{ content_text: string; updated_date: Date } | null> {
  const sql = `
    SELECT content_text, updated_date
    FROM ${TABLE}
    WHERE tenant_id = $1 AND memory_type = 'long_term' AND status = 1
    ORDER BY updated_date DESC
    LIMIT 1
  `;

  const result = await query<{ content_text: string; updated_date: Date }>(sql, [tenantId]);
  return result.rows[0] ?? null;
}

// ─── Load Recent Daily Notes ───

export async function loadRecentDailyNotes(
  tenantId: string,
  sinceDate: string
): Promise<Array<{ content_text: string; memory_date: string }>> {
  const sql = `
    SELECT content_text, memory_date
    FROM ${TABLE}
    WHERE tenant_id = $1 AND memory_type = 'daily_note' AND memory_date >= $2 AND status = 1
    ORDER BY memory_date DESC
  `;

  const result = await query<{ content_text: string; memory_date: string }>(sql, [
    tenantId,
    sinceDate,
  ]);
  return result.rows;
}

// ─── Update Embedding ───

export async function updateEmbedding(
  id: string,
  tenantId: string,
  embedding: number[]
): Promise<void> {
  const sql = `
    UPDATE ${TABLE}
    SET embedding = $3::vector, updated_date = NOW()
    WHERE id = $1 AND tenant_id = $2
  `;

  await query(sql, [id, tenantId, JSON.stringify(embedding)]);
}

