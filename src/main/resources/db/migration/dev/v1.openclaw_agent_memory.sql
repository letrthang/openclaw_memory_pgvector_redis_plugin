-- =====================================================================
-- OpenClaw Agent Memory — DDL Migration v1
-- PostgreSQL + pgvector
--
-- Creates:
--   1 extension (vector)
--   1 schema (v1)
--   1 parent table (hash-partitioned by tenant_id)
--   8 child partitions (_h0 .. _h7)
--   32 indexes (4 per partition)
--
-- Safe to re-run (all statements use IF NOT EXISTS).
-- =====================================================================

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create schema
CREATE SCHEMA IF NOT EXISTS v1;

-- 3. Create parent table (partitioned by hash on tenant_id)
CREATE TABLE IF NOT EXISTS v1.openclaw_agent_memory (
    id             UUID           NOT NULL,
    tenant_id      VARCHAR(128)   NOT NULL,
    memory_type    VARCHAR(32)    NOT NULL CHECK (memory_type IN ('long_term', 'daily_note', 'session')),
    content_text   TEXT           NOT NULL,
    embedding      vector,
    memory_date    DATE,
    status         SMALLINT       NOT NULL DEFAULT 1,
    created_date   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_date   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, tenant_id)
) PARTITION BY HASH (tenant_id);

-- 4. Create 8 hash partitions
CREATE TABLE IF NOT EXISTS v1.openclaw_agent_memory_h0 PARTITION OF v1.openclaw_agent_memory FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE IF NOT EXISTS v1.openclaw_agent_memory_h1 PARTITION OF v1.openclaw_agent_memory FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE IF NOT EXISTS v1.openclaw_agent_memory_h2 PARTITION OF v1.openclaw_agent_memory FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE IF NOT EXISTS v1.openclaw_agent_memory_h3 PARTITION OF v1.openclaw_agent_memory FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE IF NOT EXISTS v1.openclaw_agent_memory_h4 PARTITION OF v1.openclaw_agent_memory FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE IF NOT EXISTS v1.openclaw_agent_memory_h5 PARTITION OF v1.openclaw_agent_memory FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE IF NOT EXISTS v1.openclaw_agent_memory_h6 PARTITION OF v1.openclaw_agent_memory FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE IF NOT EXISTS v1.openclaw_agent_memory_h7 PARTITION OF v1.openclaw_agent_memory FOR VALUES WITH (MODULUS 8, REMAINDER 7);

-- 5. Create indexes on each partition (4 indexes × 8 partitions = 32 indexes)

-- ─── Partition _h0 ───
CREATE INDEX IF NOT EXISTS idx_h0_tenant_type   ON v1.openclaw_agent_memory_h0 (tenant_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_h0_tenant_active ON v1.openclaw_agent_memory_h0 (tenant_id) WHERE status = 1;
CREATE INDEX IF NOT EXISTS idx_h0_tenant_date   ON v1.openclaw_agent_memory_h0 (tenant_id, memory_date);
CREATE INDEX IF NOT EXISTS idx_h0_embedding     ON v1.openclaw_agent_memory_h0 USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ─── Partition _h1 ───
CREATE INDEX IF NOT EXISTS idx_h1_tenant_type   ON v1.openclaw_agent_memory_h1 (tenant_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_h1_tenant_active ON v1.openclaw_agent_memory_h1 (tenant_id) WHERE status = 1;
CREATE INDEX IF NOT EXISTS idx_h1_tenant_date   ON v1.openclaw_agent_memory_h1 (tenant_id, memory_date);
CREATE INDEX IF NOT EXISTS idx_h1_embedding     ON v1.openclaw_agent_memory_h1 USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ─── Partition _h2 ───
CREATE INDEX IF NOT EXISTS idx_h2_tenant_type   ON v1.openclaw_agent_memory_h2 (tenant_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_h2_tenant_active ON v1.openclaw_agent_memory_h2 (tenant_id) WHERE status = 1;
CREATE INDEX IF NOT EXISTS idx_h2_tenant_date   ON v1.openclaw_agent_memory_h2 (tenant_id, memory_date);
CREATE INDEX IF NOT EXISTS idx_h2_embedding     ON v1.openclaw_agent_memory_h2 USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ─── Partition _h3 ───
CREATE INDEX IF NOT EXISTS idx_h3_tenant_type   ON v1.openclaw_agent_memory_h3 (tenant_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_h3_tenant_active ON v1.openclaw_agent_memory_h3 (tenant_id) WHERE status = 1;
CREATE INDEX IF NOT EXISTS idx_h3_tenant_date   ON v1.openclaw_agent_memory_h3 (tenant_id, memory_date);
CREATE INDEX IF NOT EXISTS idx_h3_embedding     ON v1.openclaw_agent_memory_h3 USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ─── Partition _h4 ───
CREATE INDEX IF NOT EXISTS idx_h4_tenant_type   ON v1.openclaw_agent_memory_h4 (tenant_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_h4_tenant_active ON v1.openclaw_agent_memory_h4 (tenant_id) WHERE status = 1;
CREATE INDEX IF NOT EXISTS idx_h4_tenant_date   ON v1.openclaw_agent_memory_h4 (tenant_id, memory_date);
CREATE INDEX IF NOT EXISTS idx_h4_embedding     ON v1.openclaw_agent_memory_h4 USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ─── Partition _h5 ───
CREATE INDEX IF NOT EXISTS idx_h5_tenant_type   ON v1.openclaw_agent_memory_h5 (tenant_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_h5_tenant_active ON v1.openclaw_agent_memory_h5 (tenant_id) WHERE status = 1;
CREATE INDEX IF NOT EXISTS idx_h5_tenant_date   ON v1.openclaw_agent_memory_h5 (tenant_id, memory_date);
CREATE INDEX IF NOT EXISTS idx_h5_embedding     ON v1.openclaw_agent_memory_h5 USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ─── Partition _h6 ───
CREATE INDEX IF NOT EXISTS idx_h6_tenant_type   ON v1.openclaw_agent_memory_h6 (tenant_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_h6_tenant_active ON v1.openclaw_agent_memory_h6 (tenant_id) WHERE status = 1;
CREATE INDEX IF NOT EXISTS idx_h6_tenant_date   ON v1.openclaw_agent_memory_h6 (tenant_id, memory_date);
CREATE INDEX IF NOT EXISTS idx_h6_embedding     ON v1.openclaw_agent_memory_h6 USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ─── Partition _h7 ───
CREATE INDEX IF NOT EXISTS idx_h7_tenant_type   ON v1.openclaw_agent_memory_h7 (tenant_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_h7_tenant_active ON v1.openclaw_agent_memory_h7 (tenant_id) WHERE status = 1;
CREATE INDEX IF NOT EXISTS idx_h7_tenant_date   ON v1.openclaw_agent_memory_h7 (tenant_id, memory_date);
CREATE INDEX IF NOT EXISTS idx_h7_embedding     ON v1.openclaw_agent_memory_h7 USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

