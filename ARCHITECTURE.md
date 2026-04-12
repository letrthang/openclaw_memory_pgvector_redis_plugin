# ARCHITECTURE.md — OpenClaw Memory Plugin (memory-pg-redis)

> Technical architecture document for the custom OpenClaw memory plugin (MCP-16).
> Covers data flow, storage design, caching strategy, security model, deployment topology,
> and integration with the Thần Nông AI module.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Data Flow Architecture](#2-data-flow-architecture)
3. [Storage Layer Design](#3-storage-layer-design)
4. [Caching Strategy](#4-caching-strategy)
5. [Security & Tenant Isolation](#5-security--tenant-isolation)
6. [Deployment Topology](#6-deployment-topology)
7. [Plugin Interface & Operations](#7-plugin-interface--operations)
8. [Database Design](#8-database-design)
9. [Integration Points](#9-integration-points)
10. [Failure Modes & Recovery](#10-failure-modes--recovery)
11. [Performance Characteristics](#11-performance-characteristics)
12. [Future Considerations](#12-future-considerations)

---

## 1. System Overview

### 1.1 Problem Statement

OpenClaw's default memory system stores data on the pod's local filesystem:

```
Default OpenClaw Memory (broken in multi-pod K8s):
    Pod A filesystem:                     Pod B filesystem:
    ├── MEMORY.md (long-term facts)       ├── MEMORY.md (different facts!)
    ├── memory/                           ├── memory/
    │   ├── 2026-04-10.md                 │   ├── 2026-04-10.md (different!)
    │   ├── 2026-04-11.md                 │   └── 2026-04-12.md
    │   └── 2026-04-12.md                 └── .sqlite (different index!)
    └── .sqlite (vector index)
```

Each pod maintains its own copy of memory — they diverge immediately. S3-based syncing introduces last-write-wins race conditions.

### 1.2 Solution Architecture

```
memory-pg-redis Plugin (shared across all pods):

    Pod A ──┐                         ┌── Pod B
    Pod C ──┤   ┌─────────────────┐   ├── Pod D
            ├──▶│  PostgreSQL     │◀──┤
            │   │  (source of     │   │
            │   │   truth)        │   │
            │   │  + pgvector     │   │
            │   └────────┬────────┘   │
            │            │            │
            │   ┌────────▼────────┐   │
            └──▶│     Redis       │◀──┘
                │  (hot cache)    │
                └─────────────────┘
```

All pods share the same PostgreSQL and Redis instances. Memory operations are atomic — no race conditions.

### 1.3 Design Principles

| Principle | Implementation |
|-----------|---------------|
| **PostgreSQL is source of truth** | Every write goes to PostgreSQL first (sync). Redis is always a cache — never the only copy. |
| **Redis is hot cache only** | If Redis loses data, PostgreSQL has the authoritative copy. `startup_load` re-warms Redis automatically. |
| **Tenant isolation is mandatory** | Every SQL query includes `WHERE company_id = $1`. This is in the plugin code — not in the LLM prompt. |
| **Atomic writes** | PostgreSQL uses `INSERT ... ON CONFLICT DO UPDATE` (upsert). Redis uses atomic `SET`. No multi-step transactions needed. |
| **Fail open to PostgreSQL** | On any Redis failure, operations fall through to PostgreSQL directly. The bot never returns empty without checking the DB. |

---

## 2. Data Flow Architecture

### 2.1 Write Path (`memory_save`)

```
OpenClaw Agent decides to save a memory
    │
    ▼
memory_save(content, memory_type, company_id)
    │
    ├── [1] PostgreSQL UPSERT (SYNC — blocks until confirmed)
    │       INSERT INTO v1.thannong_ai_openclaw_agent_memory
    │         (id, company_id, memory_type, content_text, embedding, ...)
    │       VALUES ($1, $2, $3, $4, $5::vector, ...)
    │       ON CONFLICT (id, company_id)
    │       DO UPDATE SET content_text = EXCLUDED.content_text,
    │                     embedding = EXCLUDED.embedding,
    │                     updated_date = NOW();
    │
    ├── [2] Redis SET (SYNC — blocks until confirmed)
    │       Key depends on memory_type:
    │       • long_term  → SET ThanNongAI:company:{cid}:openclaw:long_term
    │       • daily_note → SET ThanNongAI:company:{cid}:openclaw:daily:{date}  TTL 24h
    │       • session    → SET ThanNongAI:company:{cid}:openclaw:session:{sid} TTL 1h
    │
    ├── [3] Redis DEL search cache (SYNC)
    │       DEL ThanNongAI:company:{cid}:openclaw:search:*
    │       (stale search results may reference old memory content)
    │
    └── [4] Async: Generate embedding (BACKGROUND)
            Call OpenAI text-embedding-3-small API
            UPDATE v1.thannong_ai_openclaw_agent_memory
              SET embedding = $1::vector WHERE id = $2 AND company_id = $3
```

### 2.2 Read Path (`memory_search`)

```
OpenClaw Agent wants to recall memory
    │
    ▼
memory_search(query, company_id)
    │
    ├── [1] Normalize query
    │       lowercase → strip .?!,;: → trim → collapse spaces → SHA-256
    │       Example: "Policy on remote work?" → sha256("policy on remote work") → {hash}
    │
    ├── [2] Redis GET search cache
    │       Key: ThanNongAI:company:{cid}:openclaw:search:{hash}
    │       HIT → return cached results (latency: ~1ms)
    │       │
    │       MISS ↓
    │
    ├── [3] pgvector HNSW search on PostgreSQL
    │       SET LOCAL hnsw.ef_search = 40;
    │       SELECT id, memory_type, content_text, memory_date,
    │              1 - (embedding <=> $1::vector) AS similarity
    │       FROM v1.thannong_ai_openclaw_agent_memory
    │       WHERE company_id = $2 AND status = 1
    │         AND ($3::varchar IS NULL OR memory_type = $3)
    │       ORDER BY embedding <=> $1::vector
    │       LIMIT 5;
    │
    ├── [4] Cache result in Redis
    │       SET ThanNongAI:company:{cid}:openclaw:search:{hash}
    │       TTL: 5 minutes
    │
    └── [5] Return top-K results to agent
```

### 2.3 Startup Path (`startup_load`)

```
Bot pod starts / new session begins
    │
    ▼
startup_load(company_id)
    │
    ├── [1] Load long_term memory
    │       Redis GET ThanNongAI:company:{cid}:openclaw:long_term
    │       HIT → use as initial context
    │       MISS → SELECT FROM PostgreSQL WHERE memory_type = 'long_term' AND status = 1
    │              → warm Redis key (no TTL)
    │
    ├── [2] Load recent daily notes
    │       Redis GET ThanNongAI:company:{cid}:openclaw:daily:{today}
    │       Redis GET ThanNongAI:company:{cid}:openclaw:daily:{yesterday}
    │       MISS → SELECT FROM PostgreSQL WHERE memory_type = 'daily_note'
    │              AND memory_date >= yesterday AND status = 1
    │              → warm Redis keys (TTL 24h)
    │
    └── [3] Return combined context to agent
            Agent uses this as starting context for the session
```

---

## 3. Storage Layer Design

### 3.1 Two-Layer Storage Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Redis (Hot Cache)                                  │
│                                                              │
│  Purpose: Fast reads during agent reasoning loop             │
│  Latency: ~1ms                                               │
│  Durability: None — cache only                               │
│  Scope: Per-company, per-memory-type                         │
│                                                              │
│  Keys:                                                       │
│  • openclaw:long_term        (no TTL — persistent in Redis)  │
│  • openclaw:daily:{date}     (TTL 24h)                       │
│  • openclaw:session:{sid}    (TTL 1h)                        │
│  • openclaw:search:{hash}    (TTL 5m)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ fallback on miss
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: PostgreSQL + pgvector (Source of Truth)             │
│                                                              │
│  Purpose: Durable storage, semantic search                   │
│  Latency: ~5-10ms (HNSW search), ~2ms (B-tree lookup)       │
│  Durability: Full — survives pod restarts, Redis flushes     │
│  Scope: HASH(company_id) × 8 partitions                     │
│                                                              │
│  Table: v1.thannong_ai_openclaw_agent_memory                 │
│  Indexes: 32 total (4 per partition × 8 partitions)          │
│  Vector: HNSW (m=16, ef_construction=64, cosine distance)    │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Write Ordering Guarantee

```
memory_save() execution order:

    [1] PostgreSQL UPSERT  ←── MUST complete first (sync, durable)
         ↓ success
    [2] Redis SET          ←── Update cache (sync)
         ↓ success
    [3] Redis DEL search:* ←── Evict stale search cache (sync)
         ↓ success
    [4] Async embedding    ←── Non-blocking (background)

If [1] fails → abort, return error (nothing written anywhere)
If [2] fails → PostgreSQL has the data; Redis will miss, fallback works
If [3] fails → stale search results may persist for up to 5 min (TTL)
If [4] fails → retry in next memory_save or background job
```

### 3.3 Consistency Model

| Scenario | Behavior |
|----------|----------|
| Normal operation | Strong consistency — write to PG first, then Redis |
| Redis down | Write succeeds in PG. Reads fall through to PG (slower but correct). |
| PostgreSQL down | Write fails. Error returned to agent. No partial writes. |
| Pod crash mid-write | If PG upsert completed, data is safe. Redis may be stale — `startup_load` will correct. |
| Network partition | PG write may time out. Agent receives error. No inconsistency. |

---

## 4. Caching Strategy

### 4.1 Cache Layer Design

```
Agent memory_search("remote work policy")
    │
    ▼
┌────────────────────────────────────────────────────┐
│  Search Cache (Redis)                               │
│  Key: openclaw:search:{sha256("remote work policy")}│
│  TTL: 5 minutes                                     │
│  Hit rate: ~30-40% (repeated/similar queries)        │
│  Latency: ~1ms                                       │
└──────────────────────┬─────────────────────────────┘
                       │ MISS
                       ▼
┌────────────────────────────────────────────────────┐
│  pgvector HNSW Search (PostgreSQL)                  │
│  WHERE company_id = $1 AND status = 1               │
│  ORDER BY embedding <=> query_vector                 │
│  LIMIT 5                                             │
│  Latency: ~5-10ms                                    │
│  Result cached in Redis for 5 min                    │
└────────────────────────────────────────────────────┘
```

### 4.2 Cache Invalidation Rules

| Event | Keys Invalidated | Reason |
|-------|-----------------|--------|
| `memory_save` (any type) | `openclaw:search:*` for that `{cid}` | New memory may change search results |
| `memory_save` (long_term) | `openclaw:long_term` for that `{cid}` | Content updated |
| `memory_save` (daily_note) | `openclaw:daily:{date}` for that `{cid}` | Content updated |
| Scheduler soft-deletes old daily notes | `openclaw:daily:{date}` + `openclaw:search:*` | Stale data evicted |
| Redis key TTL expires | Self-evicts | Natural expiration |

### 4.3 Query Normalization Spec

To maximize cache hits on the `openclaw:search:*` keys:

```
Input:   "Policy on Remote Work?"
Step 1:  lowercase         → "policy on remote work?"
Step 2:  strip .?!,;:      → "policy on remote work"
Step 3:  trim whitespace   → "policy on remote work"
Step 4:  collapse spaces   → "policy on remote work"
Step 5:  SHA-256           → "a1b2c3d4..."

Result: All of these hit the SAME cache key:
  • "Policy on remote work?"
  • "policy on remote work"
  • "policy on remote work ?"
  • "  Policy  on  Remote  Work  "
```

---

## 5. Security & Tenant Isolation

### 5.1 Defense Layers

```
Layer 1: Plugin Code               → company_id hardcoded in every SQL query
Layer 2: PostgreSQL Partition       → HASH(company_id) routes to 1 of 8 partitions
Layer 3: Read-Only DB Role          → thannong_ai_readonly — no INSERT/UPDATE/DELETE
Layer 4: Redis Key Namespace        → ThanNongAI:company:{cid}:openclaw:*
Layer 5: HTTP Header Injection      → company_id from Spring Boot session, not user input
```

### 5.2 SQL Tenant Filter (Non-Negotiable)

Every SQL query generated by this plugin MUST include `WHERE company_id = $1`:

```sql
-- ✅ CORRECT: company_id in WHERE clause
SELECT * FROM v1.thannong_ai_openclaw_agent_memory
WHERE company_id = $1 AND memory_type = 'long_term' AND status = 1;

-- ❌ WRONG: missing company_id → scans ALL 8 partitions, cross-tenant data leak
SELECT * FROM v1.thannong_ai_openclaw_agent_memory
WHERE memory_type = 'long_term' AND status = 1;
```

### 5.3 Redis Key Isolation

All Redis keys include the company ID as a namespace segment:

```
ThanNongAI:company:{COMPANY_A_ID}:openclaw:long_term    ← Company A's memory
ThanNongAI:company:{COMPANY_B_ID}:openclaw:long_term    ← Company B's memory (completely separate)
```

There is no key pattern that can access multiple companies' data in a single operation.

### 5.4 Identity Chain

```
Browser (authenticated user)
    → Cookie → Spring Boot Session → MainView.companyID
    → HTTP Header: X-Company-ID (set by ThanNongAiCompanyBotClient, NOT by user)
    → OpenClaw Bot receives company_id from trusted HTTP header
    → memory-pg-redis plugin uses company_id in every operation
    → PostgreSQL query includes WHERE company_id = $1

At NO point does the LLM (Claude) control or influence the company_id value.
The company_id is injected by the Java service layer from the authenticated session.
```

---

## 6. Deployment Topology

### 6.1 Kubernetes Architecture

```
┌──────────────────────────────────────────────────────────────┐
│           DigitalOcean Kubernetes Cluster (default ns)        │
│                                                              │
│  ┌─────────────┐    ClusterIP     ┌──────────────────────┐  │
│  │ iAttendance │───(internal)────▶│ OpenClaw Bot Pod      │  │
│  │  App Pods   │   :3000          │ (Deployment: 1x)      │  │
│  │  (2-4x)     │                  │                        │  │
│  │  :9090      │                  │ ┌──────────────────┐  │  │
│  └──────┬──────┘                  │ │ openclaw-bot     │  │  │
│         │                         │ │ (main container) │  │  │
│         │                         │ │                  │  │  │
│         │                         │ │ plugins/         │  │  │
│         │                         │ │ └─memory-pg-redis│  │  │
│         │                         │ │   (THIS PLUGIN)  │  │  │
│         │                         │ └──────────────────┘  │  │
│         │                         │                        │  │
│         │                         │ ┌──────────────────┐  │  │
│         │                         │ │ mcp-server       │  │  │
│         │                         │ │ (sidecar)        │  │  │
│         │                         │ └──────────────────┘  │  │
│         │                         └──────────┬───────────┘  │
│         │                                    │               │
│         ▼                                    ▼               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Shared Infrastructure                                │   │
│  │  • PostgreSQL (DO Managed, :25061, SSL)               │   │
│  │    └── pgvector extension enabled                     │   │
│  │    └── v1.thannong_ai_openclaw_agent_memory (8 parts) │   │
│  │  • Redis (DO Managed, :25061, SSL)                    │   │
│  │    └── ThanNongAI:company:{cid}:openclaw:* keys       │   │
│  │  • RabbitMQ (Operator pod, :5672)                     │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 Pod Lifecycle Integration

```
Pod Created (Deployment/Restart/Scale-up)
    │
    ├── [InitContainer] sync-data-restore
    │       Python script restores CONFIG from S3 to /data/bot/
    │       (openclaw.json, SOUL.md, TOOLS.md — NOT memory)
    │
    ├── [Main Container] openclaw-bot starts
    │       Reads openclaw.json → discovers memory plugin = "memory-pg-redis"
    │       │
    │       ├── Plugin initializes:
    │       │   ├── Connect to PostgreSQL (from DATABASE_URL env)
    │       │   ├── Connect to Redis (from REDIS_URL env)
    │       │   └── Register memory_save / memory_search / startup_load hooks
    │       │
    │       └── First session starts → startup_load(company_id):
    │           ├── Load long_term from Redis (or PG fallback)
    │           ├── Load today + yesterday daily_notes
    │           └── Agent has full memory context
    │
    ├── [Normal Operation]
    │       Agent processes chat messages
    │       memory_save() called on new learnings → PG UPSERT + Redis SET
    │       memory_search() called during reasoning → Redis cache / PG HNSW
    │
    └── [Pod Shutdown] (SIGTERM)
        terminationGracePeriodSeconds: 30
        ├── MCP connections close gracefully
        ├── No memory flush needed — already persisted on every write
        └── No preStop hook, no backup sidecar
```

### 6.3 Environment Variables

| Variable | Source | Description |
|----------|--------|-------------|
| `DATABASE_URL` | K8S Secret (`thannong-ai-secrets`) | PostgreSQL connection string (read-write for memory table) |
| `REDIS_URL` | K8S Secret (`thannong-ai-secrets`) | Redis connection string (SSL) |
| `OPENAI_API_KEY` | K8S Secret (`thannong-ai-secrets`) | For embedding generation (`text-embedding-3-small`) |

---

## 7. Plugin Interface & Operations

### 7.1 Plugin Slot Configuration

OpenClaw supports a memory plugin slot natively. Setting `plugins.slots.memory = "memory-pg-redis"` disables the default memory system entirely and routes all memory operations to this plugin.

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-pg-redis"
    }
  }
}
```

### 7.2 Operation Signatures

| Operation | Trigger | Parameters | Return |
|-----------|---------|------------|--------|
| `memory_save` | Agent learns a new fact or decision | `content: string`, `memory_type: string`, `company_id: string` | `void` (or error) |
| `memory_search` | Agent needs to recall past knowledge | `query: string`, `company_id: string`, `type_filter?: string`, `limit?: number` | `MemoryResult[]` |
| `startup_load` | New session starts or pod restarts | `company_id: string` | `MemoryContext` (long_term + recent daily_notes) |

### 7.3 What Gets Disabled

After plugin activation, the following OpenClaw default behaviors are suppressed:

| Default Behavior | Status | Replacement |
|-----------------|--------|-------------|
| Write `MEMORY.md` to local disk | ❌ Disabled | PostgreSQL `memory_type = 'long_term'` |
| Write `memory/YYYY-MM-DD.md` | ❌ Disabled | PostgreSQL `memory_type = 'daily_note'` |
| SQLite vector index | ❌ Disabled | pgvector HNSW on PostgreSQL |
| Local file reads on startup | ❌ Disabled | `startup_load` from Redis / PostgreSQL |

---

## 8. Database Design

### 8.1 Table Schema

```sql
CREATE TABLE v1.thannong_ai_openclaw_agent_memory (
    id           varchar        NOT NULL,
    company_id   varchar        NOT NULL,   -- HASH PARTITION KEY
    memory_type  varchar(50)    NOT NULL,   -- 'long_term', 'daily_note', 'session'
    content_text text           NOT NULL,   -- Raw memory content
    embedding    vector(1536)   NOT NULL,   -- OpenAI text-embedding-3-small
    memory_date  date           NULL,       -- For daily_note only
    status       int4           NOT NULL DEFAULT 1,  -- 1=ACTIVE, 0=DELETED
    created_date timestamp      NOT NULL,
    updated_date timestamp      NOT NULL,
    CONSTRAINT thannong_ai_openclaw_agent_memory_pkey PRIMARY KEY (id, company_id)
) PARTITION BY HASH (company_id);
```

### 8.2 Partitioning Strategy

```
HASH(company_id) × 8 partitions:

    hash_0: companies where hash(company_id) % 8 = 0
    hash_1: companies where hash(company_id) % 8 = 1
    ...
    hash_7: companies where hash(company_id) % 8 = 7

Estimated size:
    ~500 rows/company × 5,000 companies = ~2.5M rows total
    ~2.5M / 8 partitions = ~312K rows per partition
    Each partition has its own independent HNSW graph
```

### 8.3 Index Strategy

Each partition has 4 indexes (32 total across all partitions):

```
Per partition:
    ┌─────────────────────────────────────────────────────────┐
    │  1. B-tree (company_id, memory_type)                     │
    │     → filter by type: startup_load, type-specific queries │
    │                                                           │
    │  2. B-tree partial (company_id) WHERE status = 1          │
    │     → active-only queries (most common access pattern)    │
    │                                                           │
    │  3. B-tree (company_id, memory_date)                      │
    │     → daily note lookup: load today + yesterday           │
    │                                                           │
    │  4. HNSW (embedding vector_cosine_ops)                    │
    │     m = 16, ef_construction = 64                          │
    │     → ANN semantic search for memory_search               │
    └─────────────────────────────────────────────────────────┘
```

### 8.4 Key SQL Patterns

**Startup load (long_term):**
```sql
SELECT id, memory_type, content_text, memory_date
FROM v1.thannong_ai_openclaw_agent_memory
WHERE company_id = $1 AND memory_type = 'long_term' AND status = 1
ORDER BY updated_date DESC LIMIT 1;
```

**Startup load (recent daily notes):**
```sql
SELECT id, memory_type, content_text, memory_date
FROM v1.thannong_ai_openclaw_agent_memory
WHERE company_id = $1 AND memory_type = 'daily_note'
  AND memory_date >= $2 AND status = 1
ORDER BY memory_date DESC;
```

**Semantic search:**
```sql
SET LOCAL hnsw.ef_search = 40;
SELECT id, memory_type, content_text, memory_date,
       1 - (embedding <=> $1::vector) AS similarity
FROM v1.thannong_ai_openclaw_agent_memory
WHERE company_id = $2 AND status = 1
  AND ($3::varchar IS NULL OR memory_type = $3)
ORDER BY embedding <=> $1::vector
LIMIT $4;
```

**Memory save (upsert):**
```sql
INSERT INTO v1.thannong_ai_openclaw_agent_memory
  (id, company_id, memory_type, content_text, embedding, memory_date, status, created_date, updated_date)
VALUES ($1, $2, $3, $4, $5::vector, $6, 1, NOW(), NOW())
ON CONFLICT (id, company_id)
DO UPDATE SET
  content_text = EXCLUDED.content_text,
  embedding    = EXCLUDED.embedding,
  memory_date  = EXCLUDED.memory_date,
  updated_date = NOW();
```

**Scheduler: soft-delete old daily notes (90 days):**
```sql
UPDATE v1.thannong_ai_openclaw_agent_memory
SET status = 0, updated_date = NOW()
WHERE company_id = $1 AND memory_type = 'daily_note'
  AND memory_date < $2 AND status = 1;
```

---

## 9. Integration Points

### 9.1 With iAttendance App (Java / Spring Boot)

```
iAttendance App                        OpenClaw Bot + Plugin
─────────────                          ─────────────────────
ThanNongAiCompanyBotClient.java
  ├── HTTP POST to thannong-ai-svc:3000/v1/chat
  ├── Headers: X-Company-ID, X-Shop-ID, X-User-Email
  │   (from authenticated Spring session — NOT user input)
  └── Bot processes request
        └── memory-pg-redis plugin:
            ├── memory_search() during reasoning
            ├── memory_save() on new learnings
            └── All queries use company_id from header
```

### 9.2 With Schedulers (Java)

| Scheduler | Interaction with this plugin's data |
|-----------|-------------------------------------|
| `SchedulerThanNongAiCompanySessionCleanup` | Soft-deletes `daily_note` rows older than 90 days. Evicts corresponding Redis keys. |
| `SchedulerThanNongAiCompanyBotHealthCheck` | Pings bot health endpoint — indirectly verifies plugin can reach PostgreSQL and Redis. |

### 9.3 With Custom MCP Server (Node.js)

The Custom MCP Server (`thannong-ai-mcp-server`) provides read-only SQL tools for business data queries. It does NOT access the `thannong_ai_openclaw_agent_memory` table — that's exclusively managed by this plugin.

```
MCP Server tools: query_sell_items, query_orders, etc. → business data tables
This plugin:      memory_save, memory_search, startup_load → agent memory table
```

No overlap. No conflict.

---

## 10. Failure Modes & Recovery

### 10.1 Failure Scenarios

| Failure | Impact | Recovery |
|---------|--------|----------|
| **Redis unavailable** | `memory_search` falls through to PostgreSQL (slower, ~5-10ms instead of ~1ms). `memory_save` writes to PostgreSQL only — Redis updated on next successful connection. | Automatic: next operation warms Redis. |
| **PostgreSQL unavailable** | `memory_save` fails — error returned to agent. `memory_search` checks Redis cache first — may return stale data for up to 5 min (search cache TTL). `startup_load` may fail if Redis also has no data. | Manual: wait for PostgreSQL recovery. Data is safe (PostgreSQL is managed DB with replication). |
| **Pod crash during `memory_save`** | If PostgreSQL UPSERT completed: data is safe, Redis may be stale. If UPSERT did not complete: nothing was written anywhere (atomic). | Automatic: `startup_load` on new pod corrects Redis. |
| **Embedding API down** | Memory text is saved without embedding vector. Semantic search won't find this entry until embedding is generated. | Background retry: next `memory_save` or scheduled job re-generates embedding. |
| **Redis key expired** | Normal operation — `startup_load` or next access re-warms from PostgreSQL. | Automatic. |

### 10.2 Data Recovery

```
If Redis is completely flushed:
    → No data loss. PostgreSQL has everything.
    → startup_load() re-warms Redis from PostgreSQL automatically.
    → Search cache rebuilds naturally on first queries.

If a partition needs REINDEX:
    → REINDEX INDEX CONCURRENTLY idx_thannong_ai_ocmem_hN_vector_hnsw;
    → No downtime, no data loss.

If a company is deleted:
    → FK ON DELETE CASCADE removes all memory rows automatically.
    → Redis keys expire naturally (or can be explicitly DEL'd).
```

---

## 11. Performance Characteristics

### 11.1 Latency Targets

| Operation | Redis Hit | Redis Miss (PG fallback) |
|-----------|-----------|--------------------------|
| `memory_search` | ~1ms | ~5-10ms (HNSW search) |
| `memory_save` | N/A | ~2-5ms (UPSERT) + ~1ms (Redis SET) |
| `startup_load` | ~2ms (2 Redis GETs) | ~5ms (2 PostgreSQL SELECTs) |

### 11.2 Capacity Planning

| Metric | Current | At Scale |
|--------|---------|----------|
| Rows per company | ~50 | ~500 |
| Total companies | ~500 | ~5,000 |
| Total rows | ~25,000 | ~2,500,000 |
| Rows per partition | ~3,125 | ~312,500 |
| HNSW graph size per partition | Tiny | Moderate (well within optimal) |
| Redis memory per company | ~10 KB | ~100 KB |
| Total Redis memory (this plugin) | ~5 MB | ~500 MB |

### 11.3 HNSW Index Tuning

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `m` | 16 | Max connections per node. Good for <1M rows per partition. |
| `ef_construction` | 64 | Build-time search breadth. Balanced quality vs build speed. |
| `ef_search` (query time) | 40 (default) | Increase to 100 for higher recall at cost of latency. |
| `vector_cosine_ops` | — | Cosine distance — standard for normalized text embeddings. |

---

## 12. Future Considerations

### 12.1 Multi-Replica Scaling

Current deployment uses 1 replica with `Recreate` strategy. To scale:

1. Change `strategy.type` from `Recreate` to `RollingUpdate`
2. Increase `replicas` to desired count
3. No code changes needed — memory sharing works out of the box

### 12.2 Partition Growth

At extreme scale (>10M rows), consider:
- Increasing partitions from 8 to 16 or 32 (requires table recreation)
- Adding RANGE sub-partitioning on `created_date` for time-bounded pruning
- Per-company partition (if a single company exceeds 1M memory rows)

### 12.3 Embedding Model Migration

If the embedding model changes (e.g., to `text-embedding-3-large` with 3072 dimensions):
1. Alter column: `ALTER TABLE ... ALTER COLUMN embedding TYPE vector(3072)`
2. Re-embed all rows (batch job)
3. REINDEX HNSW indexes on all partitions
4. Update plugin config to use new model

### 12.4 Read Replicas

For read-heavy workloads, PostgreSQL read replicas could handle `memory_search`:
- Write path → primary PostgreSQL
- Read path → read replica (with acceptable replication lag for search)
- No code change needed — just connection string routing

