# ARCHITECTURE.md — OpenClaw Memory Plugin (memory-pgvector-redis)

> Technical architecture document for the custom OpenClaw memory plugin (MCP-16).
> Covers data flow, storage design, caching strategy, security model, deployment topology,
> and integration patterns for generic multi-tenant use.
>
> **Author**: [Thang Le](https://github.com/letrthang) · **Repository**: [openclaw_memory_pgvector_redis_plugin](https://github.com/letrthang/openclaw_memory_pgvector_redis_plugin) · **License**: MIT

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
memory-pgvector-redis Plugin (shared across all pods):

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
| **Tenant isolation is mandatory** | Every SQL query includes `WHERE tenant_id = $1`. This is in the plugin code — not in the LLM prompt. |
| **Atomic writes** | PostgreSQL uses `INSERT ... ON CONFLICT DO UPDATE` (upsert). Redis uses atomic `SET`. No multi-step transactions needed. |
| **Fail open to PostgreSQL** | On any Redis failure, operations fall through to PostgreSQL directly. The bot never returns empty without checking the DB. |

### 1.4 Generic Tenant Model

The plugin uses **`tenant_id`** as an opaque isolation key. It does not interpret or validate the value — the calling application is responsible for mapping its domain entity:

```
┌──────────────────────────────────────────────────────────────┐
│  Calling Application                                         │
│                                                              │
│  B2B SaaS:      company_id    ──┐                            │
│  Customer portal: customer_id  ──┼── mapped to → tenant_id   │
│  Admin portal:  admin_user_id ──┤                            │
│  Personal bot:  user_id       ──┘                            │
│                                                              │
│  tenant_id is passed to every plugin operation               │
│  Plugin treats it as an opaque VARCHAR for isolation          │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Data Flow Architecture

### 2.1 Write Path (`memory_save`)

```
OpenClaw Agent decides to save a memory
    │
    ▼
memory_save(content, memory_type, tenant_id)
    │
    ├── [1] PostgreSQL UPSERT (SYNC — blocks until confirmed)
    │       INSERT INTO {table}
    │         (id, tenant_id, memory_type, content_text, embedding, ...)
    │       VALUES ($1, $2, $3, $4, $5::vector, ...)
    │       ON CONFLICT (id, tenant_id)
    │       DO UPDATE SET content_text = EXCLUDED.content_text,
    │                     embedding = EXCLUDED.embedding,
    │                     updated_date = NOW();
    │
    ├── [2] Normalize content (same 7-step pipeline as memory_search)
    │       strip punctuation → trim → lowercase → remove accents
    │       → collapse whitespace → SHA-256 → {normalizedHash}
    │
    ├── [3] Redis SET memory-type cache (SYNC — blocks until confirmed)
    │       Key depends on memory_type:
    │       • long_term  → SET {prefix}:{tid}:long_term
    │       • daily_note → SET {prefix}:{tid}:daily:{date}  TTL 24h
    │       • session    → SET {prefix}:{tid}:session:{sid} TTL 1h
    │
    ├── [4] Redis SET search cache (SYNC — pre-warm)
    │       SET {prefix}:{tid}:search:{normalizedHash}  TTL 5m
    │       (next memory_search for this content will be a cache HIT)
    │
    ├── [5] Redis DEL stale search cache (SYNC)
    │       DEL {prefix}:{tid}:search:* EXCEPT the key written in [4]
    │       (old search results may reference outdated memory content)
    │
    └── [6] Async: Generate embedding (BACKGROUND)
            Call OpenAI text-embedding-3-small API
            UPDATE {table}
              SET embedding = $1::vector WHERE id = $2 AND tenant_id = $3
```

### 2.2 Read Path (`memory_search`)

```
OpenClaw Agent wants to recall memory
    │
    ▼
memory_search(query, tenant_id)
    │
    ├── [1] Normalize query (same 7-step pipeline as memory_save)
    │       strip punctuation → trim → lowercase → remove accents
    │       → collapse whitespace → SHA-256
    │       Example: " What is  Thần Nông AI ?" → sha256("what is than nong ai") → {hash}
    │
    ├── [2] Redis GET search cache
    │       Key: {prefix}:{tid}:search:{hash}
    │       HIT → return cached results (latency: ~1ms)
    │       │
    │       MISS ↓
    │
    ├── [3] pgvector HNSW search on PostgreSQL
    │       SET LOCAL hnsw.ef_search = 40;
    │       SELECT id, memory_type, content_text, memory_date,
    │              1 - (embedding <=> $1::vector) AS similarity
    │       FROM {table}
    │       WHERE tenant_id = $2 AND status = 1
    │         AND ($3::varchar IS NULL OR memory_type = $3)
    │       ORDER BY embedding <=> $1::vector
    │       LIMIT 5;
    │
    ├── [4] Cache result in Redis
    │       SET {prefix}:{tid}:search:{hash}
    │       TTL: 5 minutes
    │
    └── [5] Return top-K results to agent
```

### 2.3 Startup Path (`startup_load`)

```
Bot pod starts / new session begins
    │
    ▼
startup_load(tenant_id)
    │
    ├── [1] Load long_term memory
    │       Redis GET {prefix}:{tid}:long_term
    │       HIT → use as initial context
    │       MISS → SELECT FROM PostgreSQL WHERE memory_type = 'long_term' AND status = 1
    │              → warm Redis key (no TTL)
    │
    ├── [2] Load recent daily notes
    │       Redis GET {prefix}:{tid}:daily:{today}
    │       Redis GET {prefix}:{tid}:daily:{yesterday}
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
│  Scope: Per-tenant, per-memory-type                          │
│                                                              │
│  Keys ({prefix} = REDIS_KEY_PREFIX env var):                 │
│  • {prefix}:{tid}:long_term       (no TTL)                   │
│  • {prefix}:{tid}:daily:{date}    (TTL 24h)                  │
│  • {prefix}:{tid}:session:{sid}   (TTL 1h)                   │
│  • {prefix}:{tid}:search:{hash}   (TTL 5m)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │ fallback on miss
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: PostgreSQL + pgvector (Source of Truth)             │
│                                                              │
│  Purpose: Durable storage, semantic search                   │
│  Latency: ~5-10ms (HNSW search), ~2ms (B-tree lookup)       │
│  Durability: Full — survives pod restarts, Redis flushes     │
│  Scope: HASH(tenant_id) × 8 partitions                      │
│                                                              │
│  Table: {DB_TABLE_NAME} (configurable)                       │
│  Indexes: 32 total (4 per partition × 8 partitions)          │
│  Vector: HNSW (m=16, ef_construction=64, cosine distance)    │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Write Ordering Guarantee

```
memory_save() execution order:

    [1] PostgreSQL UPSERT  ←── MUST complete first (sync, durable)
         ↓ success
    [2] Normalize content   ←── 7-step pipeline → {normalizedHash}
         ↓ success
    [3] Redis SET type key  ←── Update memory-type cache (sync)
         ↓ success
    [4] Redis SET search    ←── Pre-warm search cache with normalized key (sync)
         ↓ success
    [5] Redis DEL search:*  ←── Evict stale search cache EXCEPT [4] (sync)
         ↓ success
    [6] Async embedding     ←── Non-blocking (background)

If [1] fails → abort, return error (nothing written anywhere)
If [2] fails → normalization error — log and continue without search cache
If [3] fails → PostgreSQL has the data; Redis will miss, fallback works
If [4] fails → search cache not pre-warmed; next search will miss → PG fallback
If [5] fails → stale search results may persist for up to 5 min (TTL)
If [6] fails → retry in next memory_save or background job
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
┌────────────────────────────────────────────────────────────┐
│  Search Cache (Redis)                                       │
│  Key: {prefix}:{tid}:search:{sha256("remote work policy")} │
│  TTL: 5 minutes                                             │
│  Hit rate: ~30-40% (repeated/similar queries)                │
│  Latency: ~1ms                                               │
└──────────────────────┬─────────────────────────────────────┘
                       │ MISS
                       ▼
┌────────────────────────────────────────────────────────────┐
│  pgvector HNSW Search (PostgreSQL)                          │
│  WHERE tenant_id = $1 AND status = 1                        │
│  ORDER BY embedding <=> query_vector                         │
│  LIMIT 5                                                     │
│  Latency: ~5-10ms                                            │
│  Result cached in Redis for 5 min                            │
└────────────────────────────────────────────────────────────┘
```

### 4.2 Cache Invalidation Rules

| Event | Keys Invalidated | Reason |
|-------|-----------------|--------|
| `memory_save` (any type) | `{prefix}:{tid}:search:*` | New memory may change search results |
| `memory_save` (long_term) | `{prefix}:{tid}:long_term` | Content updated |
| `memory_save` (daily_note) | `{prefix}:{tid}:daily:{date}` | Content updated |
| Scheduler soft-deletes old daily notes | `{prefix}:{tid}:daily:{date}` + `search:*` | Stale data evicted |
| Redis key TTL expires | Self-evicts | Natural expiration |

### 4.3 Query Normalization Spec

To maximize cache hits on the `{prefix}:{tid}:search:*` keys, queries are normalized before hashing:

```
Normalization Pipeline (7 steps, in order):

    Step 1: Strip punctuation    .?!,;:'"()[]{}
    Step 2: Trim whitespace      leading + trailing
    Step 3: Lowercase            all characters
    Step 4: Remove accents       Vietnamese diacritics (ầ→a, ô→o, ồ→o, ứ→u, etc.)
                                 Uses Unicode NFD decomposition + strip combining chars
    Step 5: Spell correction     Fix common typos using local Hunspell dictionaries
                                 Dual-language: en_US + vi_VN (English + Vietnamese)
                                 "wht" → "what", "recieve" → "receive"
                                 No AI, no API calls — runs locally (~0.1ms/word)
    Step 6: Collapse whitespace  multiple spaces → single space
    Step 7: SHA-256 hash         normalized string → {normalizedHash}
```

**Example with typo + Vietnamese input:**

```
Input:   " Wht is   Thần Nông AI platform ?"

Step 1:  strip punctuation  → " Wht is   Thần Nông AI platform "
Step 2:  trim whitespace    → "Wht is   Thần Nông AI platform"
Step 3:  lowercase          → "wht is   thần nông ai platform"
Step 4:  remove accents     → "wht is   than nong ai platform"
Step 5:  spell correction   → "what is   than nong ai platform"   ← "wht" → "what"
Step 6:  collapse spaces    → "what is than nong ai platform"
Step 7:  SHA-256            → "b7e9f2a1..."

Result: All of these hit the SAME cache key:
  • " Wht is   Thần Nông AI platform ?"     ← typo
  • " What is   Thần Nông AI platform ?"    ← correct
  • "What is   Thần Nông AI platform."
  • "what is than nong ai platform"
  • "  WHAT  IS  THẦN  NÔNG  AI  PLATFORM  ?  "
```

**Step 5 — Spell Correction Implementation:**

Uses **local Hunspell dictionaries (English + Vietnamese)** — no API calls, no AI token cost:

```
Library options (Node.js):
  • nspell    — Hunspell-compatible, pure JS, lightweight      (npm install nspell)
  • nodehun   — Native Hunspell C++ bindings, fastest          (npm install nodehun)
  • typo-js   — Pure JS Hunspell, works in browser + Node.js   (npm install typo-js)

Dictionaries:
  • en_US     — npm install dictionary-en
  • vi_VN     — download from LibreOffice dictionaries repo (vi_VN.dic + vi_VN.aff)
                bundle in src/dictionaries/vi_VN/

Dual-language check (per word):
  1. viSpell.correct(word) → true?  → keep as-is (valid Vietnamese)
  2. enSpell.correct(word) → true?  → keep as-is (valid English)
  3. Both false → enSpell.suggest(word) or viSpell.suggest(word)
  4. Pick top suggestion → apply correction
  5. No clear suggestion → keep original word

Example:
  "wht"   → en: false, vi: false → en.suggest → "what" ✅
  "xin"   → en: false, vi: true  → keep "xin" ✅ (Vietnamese word)
  "chao"  → en: false, vi: true  → keep "chao" ✅ (Vietnamese, accent stripped in step 4)
  "hello" → en: true             → keep "hello" ✅

~0.1ms per word. No network call. Both languages loaded at startup.
```

**Spell correction rules (for deterministic hashing):**
- Only correct words the dictionary marks as **misspelled**
- Only apply correction when there is a **single clear top suggestion** (confidence-based)
- If ambiguous → keep original word (avoid false normalization → hash mismatch)
- **Pin dictionary version** in `package.json` — different versions may suggest different words
- Add domain terms (e.g., `"pgvector"`, `"openclaw"`) to a **custom dictionary file** to avoid false corrections

**Why accent removal matters**: Vietnamese users may type with or without diacritics.
`"Thần Nông"` and `"Than Nong"` must produce the same cache key.
Implementation: Unicode NFD decomposition → strip combining characters (regex: `/[\u0300-\u036f]/g`).

**Redis key composition example:**

```
{prefix}:{tid}:search:{hash}
thannong:company:123:search:b7e9f2a1...
```

---

## 5. Security & Tenant Isolation

### 5.1 Defense Layers

```
Layer 1: Plugin Code               → tenant_id hardcoded in every SQL query
Layer 2: PostgreSQL Partition       → HASH(tenant_id) routes to 1 of 8 partitions
Layer 3: Read-Only DB Role          → Optional: read-only role for search operations
Layer 4: Redis Key Namespace        → {REDIS_KEY_PREFIX}:{tid}:*
Layer 5: Application-Layer Injection → tenant_id from authenticated session, not user input
```

### 5.2 SQL Tenant Filter (Non-Negotiable)

Every SQL query generated by this plugin MUST include `WHERE tenant_id = $1`:

```sql
-- ✅ CORRECT: tenant_id in WHERE clause
SELECT * FROM {table}
WHERE tenant_id = $1 AND memory_type = 'long_term' AND status = 1;

-- ❌ WRONG: missing tenant_id → scans ALL 8 partitions, cross-tenant data leak
SELECT * FROM {table}
WHERE memory_type = 'long_term' AND status = 1;
```

### 5.3 Redis Key Isolation

All Redis keys include the configurable prefix + tenant ID as a namespace:

```
# Instance 1: REDIS_KEY_PREFIX=thannong:company
thannong:company:{TENANT_A_ID}:long_term    ← Tenant A's memory
thannong:company:{TENANT_B_ID}:long_term    ← Tenant B's memory (completely separate)

# Instance 2: REDIS_KEY_PREFIX=portal:customer  (same Redis DB, no collision)
portal:customer:{CUSTOMER_X_ID}:long_term   ← Customer X's memory
portal:customer:{CUSTOMER_Y_ID}:long_term   ← Customer Y's memory
```

There is no key pattern that can access multiple tenants' data in a single operation.
The configurable prefix ensures multiple plugin instances can safely share the same Redis database.

### 5.4 Identity Chain

The `tenant_id` must be injected by the **application's service layer** from an authenticated session — never from user input or LLM output:

```
Authenticated User Session
    → Application service layer resolves tenant identity
    → Passes tenant_id to OpenClaw bot (via HTTP header, env var, or config)
    → memory-pgvector-redis plugin uses tenant_id in every operation
    → PostgreSQL query includes WHERE tenant_id = $1

At NO point does the LLM (Claude) control or influence the tenant_id value.
```

**Example (Spring Boot):**
```
Browser → Cookie → Spring Session → companyID → HTTP Header: X-Tenant-ID → plugin
```

**Example (Express.js):**
```
JWT → middleware extracts userId → req.tenantId → plugin
```

**Example (API Gateway):**
```
API Key → gateway resolves org_id → X-Tenant-ID header → plugin
```

---

## 6. Deployment Topology

### 6.1 Kubernetes Architecture

```
┌──────────────────────────────────────────────────────────────┐
│           Kubernetes Cluster                                  │
│                                                              │
│  ┌─────────────┐    ClusterIP     ┌──────────────────────┐  │
│  │ App Pods    │───(internal)────▶│ OpenClaw Bot Pod      │  │
│  │  (2-4x)     │   :3000          │ (Deployment: 1+x)    │  │
│  │  :9090      │                  │                        │  │
│  └──────┬──────┘                  │ ┌──────────────────┐  │  │
│         │                         │ │ openclaw-bot     │  │  │
│         │                         │ │ (main container) │  │  │
│         │                         │ │                  │  │  │
│         │                         │ │ plugins/         │  │  │
│         │                         │ │ └─memory-pgvector-redis│  │  │
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
│  │  • PostgreSQL (managed or self-hosted, SSL)           │   │
│  │    └── pgvector extension enabled                     │   │
│  │    └── {DB_TABLE_NAME} table (8 partitions)               │   │
│  │  • Redis (managed or self-hosted, SSL)                │   │
│  │    └── {REDIS_KEY_PREFIX}:{tid}:* keys                   │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 Pod Lifecycle Integration

```
Pod Created (Deployment/Restart/Scale-up)
    │
    ├── [InitContainer] (optional) restore config from object storage
    │       Restores CONFIG files (openclaw.json, SOUL.md, TOOLS.md — NOT memory)
    │
    ├── [Main Container] openclaw-bot starts
    │       Reads openclaw.json → discovers memory plugin = "memory-pgvector-redis"
    │       │
    │       ├── Plugin initializes:
    │       │   ├── Connect to PostgreSQL (from DATABASE_URL env)
    │       │   ├── Connect to Redis (from REDIS_URL env)
    │       │   └── Register memory_save / memory_search / startup_load hooks
    │       │
    │       └── First session starts → startup_load(tenant_id):
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
| `DATABASE_URL` | K8S Secret or `.env` | PostgreSQL connection string (read-write for memory table) |
| `REDIS_URL` | K8S Secret or `.env` | Redis connection string (SSL recommended) |
| `OPENAI_API_KEY` | K8S Secret or `.env` | For embedding generation (`text-embedding-3-small`) |
| `TENANCY_NAME` | K8S ConfigMap or `.env` | Human-readable label for what `tenant_id` represents (default: `COMPANY`). Used in logs, errors, and health checks — not in SQL or Redis keys. Examples: `COMPANY`, `CUSTOMER`, `USER`, `ORG`. |
| `DB_TABLE_NAME` | K8S ConfigMap or `.env` | Fully-qualified PostgreSQL table name (default: `v1.openclaw_agent_memory`). Use unique values when sharing a database across multiple plugin instances. |
| `REDIS_KEY_PREFIX` | K8S ConfigMap or `.env` | Redis key namespace prefix (default: `openclaw:memory`). Use unique values when sharing a Redis DB across multiple plugin instances. |

---

## 7. Plugin Interface & Operations

### 7.1 Plugin Slot Configuration

OpenClaw supports a memory plugin slot natively. Setting `plugins.slots.memory = "memory-pgvector-redis"` disables the default memory system entirely and routes all memory operations to this plugin.

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-pgvector-redis"
    }
  }
}
```

### 7.2 Operation Signatures

| Operation | Trigger | Parameters | Return |
|-----------|---------|------------|--------|
| `memory_save` | Agent learns a new fact or decision | `content: string`, `memory_type: string`, `tenant_id: string` | `void` (or error) |
| `memory_search` | Agent needs to recall past knowledge | `query: string`, `tenant_id: string`, `type_filter?: string`, `limit?: number` | `MemoryResult[]` |
| `startup_load` | New session starts or pod restarts | `tenant_id: string` | `MemoryContext` (long_term + recent daily_notes) |

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

The table name is configurable via `DB_TABLE_NAME` env var. Default: `v1.openclaw_agent_memory`. Example alternatives: `v1.openclaw_agent_memory_company`, `v1.openclaw_agent_memory_customer`.

```sql
-- Using default table name. Replace with your DB_TABLE_NAME value.
CREATE TABLE v1.openclaw_agent_memory (
    id           varchar        NOT NULL,
    tenant_id    varchar        NOT NULL,   -- HASH PARTITION KEY (opaque tenant isolation key)
    memory_type  varchar(50)    NOT NULL,   -- 'long_term', 'daily_note', 'session'
    content_text text           NOT NULL,   -- Raw memory content
    embedding    vector(1536)   NOT NULL,   -- OpenAI text-embedding-3-small
    memory_date  date           NULL,       -- For daily_note only
    status       int4           NOT NULL DEFAULT 1,  -- 1=ACTIVE, 0=DELETED
    created_date timestamp      NOT NULL,
    updated_date timestamp      NOT NULL,
    CONSTRAINT openclaw_agent_memory_pkey PRIMARY KEY (id, tenant_id)
) PARTITION BY HASH (tenant_id);
```

### 8.2 Partitioning Strategy

```
HASH(tenant_id) × 8 partitions:

    hash_0: tenants where hash(tenant_id) % 8 = 0
    hash_1: tenants where hash(tenant_id) % 8 = 1
    ...
    hash_7: tenants where hash(tenant_id) % 8 = 7

Estimated size:
    ~500 rows/tenant × 5,000 tenants = ~2.5M rows total
    ~2.5M / 8 partitions = ~312K rows per partition
    Each partition has its own independent HNSW graph
```

### 8.3 Index Strategy

Each partition has 4 indexes (32 total across all partitions):

```
Per partition:
    ┌─────────────────────────────────────────────────────────┐
    │  1. B-tree (tenant_id, memory_type)                      │
    │     → filter by type: startup_load, type-specific queries │
    │                                                           │
    │  2. B-tree partial (tenant_id) WHERE status = 1           │
    │     → active-only queries (most common access pattern)    │
    │                                                           │
    │  3. B-tree (tenant_id, memory_date)                       │
    │     → daily note lookup: load today + yesterday           │
    │                                                           │
    │  4. HNSW (embedding vector_cosine_ops)                    │
    │     m = 16, ef_construction = 64                          │
    │     → ANN semantic search for memory_search               │
    └─────────────────────────────────────────────────────────┘
```

### 8.4 Key SQL Patterns

> In all SQL below, `{table}` = the value of `DB_TABLE_NAME` env var (default: `v1.openclaw_agent_memory`).

**Startup load (long_term):**
```sql
SELECT id, memory_type, content_text, memory_date
FROM {table}
WHERE tenant_id = $1 AND memory_type = 'long_term' AND status = 1
ORDER BY updated_date DESC LIMIT 1;
```

**Startup load (recent daily notes):**
```sql
SELECT id, memory_type, content_text, memory_date
FROM {table}
WHERE tenant_id = $1 AND memory_type = 'daily_note'
  AND memory_date >= $2 AND status = 1
ORDER BY memory_date DESC;
```

**Semantic search:**
```sql
SET LOCAL hnsw.ef_search = 40;
SELECT id, memory_type, content_text, memory_date,
       1 - (embedding <=> $1::vector) AS similarity
FROM {table}
WHERE tenant_id = $2 AND status = 1
  AND ($3::varchar IS NULL OR memory_type = $3)
ORDER BY embedding <=> $1::vector
LIMIT $4;
```

**Memory save (upsert):**
```sql
INSERT INTO {table}
  (id, tenant_id, memory_type, content_text, embedding, memory_date, status, created_date, updated_date)
VALUES ($1, $2, $3, $4, $5::vector, $6, 1, NOW(), NOW())
ON CONFLICT (id, tenant_id)
DO UPDATE SET
  content_text = EXCLUDED.content_text,
  embedding    = EXCLUDED.embedding,
  memory_date  = EXCLUDED.memory_date,
  updated_date = NOW();
```

**Scheduler: soft-delete old daily notes (90 days):**
```sql
UPDATE {table}
SET status = 0, updated_date = NOW()
WHERE tenant_id = $1 AND memory_type = 'daily_note'
  AND memory_date < $2 AND status = 1;
```

### 8.5 Optional Foreign Key

The plugin does not enforce a specific FK. The calling application can add one based on its domain:

```sql
-- Example: B2B SaaS where tenant_id = company_id
ALTER TABLE {table}
ADD CONSTRAINT fk_tenant_company
FOREIGN KEY (tenant_id) REFERENCES v1.companies(id) ON DELETE CASCADE;

-- Example: User portal where tenant_id = user_id
ALTER TABLE {table}
ADD CONSTRAINT fk_tenant_user
FOREIGN KEY (tenant_id) REFERENCES v1.users(id) ON DELETE CASCADE;
```

---

## 9. Integration Points

### 9.1 Generic Integration Pattern

```
Your Application                       OpenClaw Bot + Plugin
────────────────                       ─────────────────────
Application Service Layer
  ├── HTTP POST to bot-service:3000/v1/chat
  ├── Headers: X-Tenant-ID (from authenticated session — NOT user input)
  └── Bot processes request
        └── memory-pgvector-redis plugin:
            ├── memory_search() during reasoning
            ├── memory_save() on new learnings
            └── All queries use tenant_id from header
```

### 9.2 Integration Example: Spring Boot (Java)

```
ThanNongAiCompanyBotClient.java
  ├── HTTP POST to thannong-ai-svc:3000/v1/chat
  ├── Headers: X-Tenant-ID (= companyID from Spring session)
  └── Bot uses tenant_id = companyID for all memory operations
```

### 9.3 Integration Example: Express.js (Node)

```
chatRouter.post('/chat', authMiddleware, (req, res) => {
  const tenantId = req.user.orgId;  // from JWT
  // Pass tenantId to OpenClaw bot via header or config
});
```

### 9.4 With Schedulers

| Scheduler | Interaction with this plugin's data |
|-----------|-------------------------------------|
| Session cleanup scheduler | Soft-deletes `daily_note` rows older than 90 days. Evicts corresponding Redis keys. |
| Health check scheduler | Pings bot health endpoint — indirectly verifies plugin can reach PostgreSQL and Redis. |

### 9.5 With Custom MCP Server

If your setup includes a Custom MCP Server for business data queries, it does NOT access the `openclaw_agent_memory` table — that's exclusively managed by this plugin.

```
MCP Server tools: business queries        → your domain data tables
This plugin:      memory_save/search/load  → agent memory table only
```

No overlap. No conflict.

---

## 10. Failure Modes & Recovery

### 10.1 Failure Scenarios

| Failure | Impact | Recovery |
|---------|--------|----------|
| **Redis unavailable** | `memory_search` falls through to PostgreSQL (slower, ~5-10ms instead of ~1ms). `memory_save` writes to PostgreSQL only — Redis updated on next successful connection. | Automatic: next operation warms Redis. |
| **PostgreSQL unavailable** | `memory_save` fails — error returned to agent. `memory_search` checks Redis cache first — may return stale data for up to 5 min (search cache TTL). `startup_load` may fail if Redis also has no data. | Manual: wait for PostgreSQL recovery. Data is safe (managed DB with replication). |
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
    → REINDEX INDEX CONCURRENTLY idx_openclaw_mem_hN_vector_hnsw;
    → No downtime, no data loss.

If a tenant is deleted:
    → FK ON DELETE CASCADE removes all memory rows automatically (if FK configured).
    → Redis keys expire naturally (or can be explicitly DEL'd).
    → Without FK: application should call a cleanup function to delete by tenant_id.
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
| Rows per tenant | ~50 | ~500 |
| Total tenants | ~500 | ~5,000 |
| Total rows | ~25,000 | ~2,500,000 |
| Rows per partition | ~3,125 | ~312,500 |
| HNSW graph size per partition | Tiny | Moderate (well within optimal) |
| Redis memory per tenant | ~10 KB | ~100 KB |
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
- Per-tenant partition (if a single tenant exceeds 1M memory rows)

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

### 12.5 Composite Tenant Keys

For advanced multi-level isolation (e.g., company + department), the calling application can compose the `tenant_id`:

```
tenant_id = "COMP-001:DEPT-SALES"   ← company + department
tenant_id = "USER-42:PROJECT-7"     ← user + project
```

The plugin treats `tenant_id` as an opaque string — any composition scheme works as long as the calling application is consistent.
