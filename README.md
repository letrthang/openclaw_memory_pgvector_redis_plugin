# OpenClaw Memory Plugin — PostgreSQL (pgvector) + Redis

> **MCP-16** — Custom OpenClaw memory plugin that replaces file-based memory with PostgreSQL + pgvector for durable shared storage and Redis for hot caching. Designed for multi-pod Kubernetes deployments with strict tenant isolation.

---

## Overview

This project implements a **custom OpenClaw memory plugin** (`memory-pg-redis`) that replaces OpenClaw's default file-based memory system (`MEMORY.md`, daily notes `.md` files, and per-pod SQLite vector index) with a shared **PostgreSQL + Redis** backend.

### Why This Plugin Exists

OpenClaw's default memory system writes files to the pod's local filesystem:
- `MEMORY.md` — long-term facts and decisions
- `memory/YYYY-MM-DD.md` — daily running context
- SQLite vector index — per-pod semantic search

**In Kubernetes multi-pod deployments, this breaks.** Each pod has its own filesystem — memory diverges across pods. Pod A learns something that Pod B never sees. Syncing via S3 introduces race conditions (last-write-wins).

This plugin solves the problem by:
- Storing all memory in **PostgreSQL** (source of truth) with **pgvector** for semantic search
- Using **Redis** as a hot cache for fast reads during the agent loop
- Enforcing **`company_id` tenant isolation** in every query — baked into the plugin code, not the LLM prompt
- Supporting **multi-pod shared memory** with atomic upserts — no race conditions

### What This Plugin Is NOT

- **NOT** a third-party plugin — we rejected `openclaw-redis-agent-memory`, `openclaw-memory-pgvector`, and `mem0` because none provide `company_id` tenant isolation
- **NOT** a general-purpose vector store — that's `v1.thannong_ai_company_vector_embeddings` (company knowledge base). This plugin manages the **bot's own learned memory** only
- **NOT** a replacement for the RAG pipeline — the iAttendance app handles embedding ingestion for products, FAQs, and documents separately

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Durable Memory** | PostgreSQL as source of truth — survives pod restarts, scaling events, and rolling updates |
| **Fast Reads** | Redis hot cache with structured key patterns — sub-millisecond memory access during agent loop |
| **Semantic Search** | pgvector HNSW indexes for ANN similarity search on memory content |
| **Tenant Isolation** | Every query includes `WHERE company_id = $1` — hardcoded in plugin code, not LLM prompt |
| **Multi-Pod Safe** | All pods read/write the same PostgreSQL + Redis — atomic upserts, no split-brain |
| **Zero Local Disk** | No `MEMORY.md`, no `.md` files, no SQLite — nothing written to local filesystem |
| **Query Normalization** | Search cache uses normalized-query SHA-256 keys — `"Policy on remote work?"` and `"policy on remote work"` hit the same cache |

---

## Architecture

```
OpenClaw Bot Pod (any of N replicas)
    │
    ├── memory_save(content, memory_type, company_id)
    │   ├── 1. PostgreSQL UPSERT (sync, durable — source of truth)
    │   ├── 2. Redis SET (sync — update hot cache)
    │   ├── 3. Redis DEL openclaw:search:* (evict stale search results)
    │   └── 4. Async: generate embedding → store in same row
    │
    ├── memory_search(query, company_id)
    │   ├── 1. Normalize query → SHA-256 hash
    │   ├── 2. Redis GET search cache → HIT: return (~1ms)
    │   ├── 3. MISS: pgvector HNSW search on PostgreSQL
    │   ├── 4. Cache result in Redis (TTL 5m)
    │   └── 5. Return top-K results
    │
    └── startup_load(company_id)
        ├── 1. Redis hit? → load context fast
        ├── 2. Miss: SELECT long_term + today/yesterday daily_note from PostgreSQL
        └── 3. Warm Redis cache for fast access during session
```

For full architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Memory Types

| `memory_type` | Replaces | Description | Redis TTL | Cleanup |
|--------------|---------|-------------|-----------|---------|
| `long_term` | `MEMORY.md` | Durable facts, preferences, decisions | No TTL | Never auto-deleted |
| `daily_note` | `memory/YYYY-MM-DD.md` | Running context for a specific day | 24h | Soft-deleted after 90 days |
| `session` | SQLite session index | Conversation highlights at session close | 1h | Fades naturally |

---

## Database Schema

### Table: `v1.thannong_ai_openclaw_agent_memory`

**Partitioning**: `HASH(company_id)` × 8 partitions
**PK**: `(id, company_id)` — PostgreSQL requires partition key in compound PK
**FK**: `company_id → v1.companies(id_company) ON DELETE CASCADE`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `varchar` (PK) | UUID — unique memory row identifier |
| `company_id` | `varchar` (PK, FK, partition key) | Tenant key — **mandatory in every WHERE clause** |
| `memory_type` | `varchar(50)` | `'long_term'`, `'daily_note'`, or `'session'` |
| `content_text` | `text` | Raw memory content — human-readable, inspectable |
| `embedding` | `vector(1536)` | OpenAI `text-embedding-3-small` output. Cosine distance via `<=>` |
| `memory_date` | `date` (nullable) | For `daily_note`: which calendar day (UTC). NULL for other types |
| `status` | `int4` (default 1) | `1`=ACTIVE, `0`=DELETED (soft-delete) |
| `created_date` | `timestamp` | Row creation time (UTC) |
| `updated_date` | `timestamp` | Last update time (UTC) |

### Indexes (4 per partition × 8 = 32 total)

| # | Index Type | Columns | Purpose |
|---|-----------|---------|---------|
| 1 | B-tree | `(company_id, memory_type)` | Filter by memory type |
| 2 | B-tree partial | `(company_id) WHERE status = 1` | Active-only queries |
| 3 | B-tree | `(company_id, memory_date)` | Daily note date lookup |
| 4 | HNSW | `embedding (vector_cosine_ops) m=16, ef_construction=64` | ANN semantic search |

### SQL Migration

The full migration file is at:
```
src/main/resources/db/migration/dev/v1.thannong_ai_company_openclaw_agent_memory.sql
```

**Prerequisite**: pgvector extension must be enabled:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## Redis Key Patterns

| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `ThanNongAI:company:{cid}:openclaw:long_term` | No TTL | Durable long-term memory (replaces MEMORY.md) |
| `ThanNongAI:company:{cid}:openclaw:daily:{date}` | 24h | Daily note context (auto-expires) |
| `ThanNongAI:company:{cid}:openclaw:session:{sid}` | 1h | Session highlights (short-lived) |
| `ThanNongAI:company:{cid}:openclaw:search:{normalizedHash}` | 5m | Cached `memory_search` results |

### Query Normalization (for search cache keys)

To increase cache hit rate, search queries are normalized before hashing:

1. **Lowercase**: `"Policy on Remote Work?"` → `"policy on remote work?"`
2. **Strip punctuation** (`.?!,;:`): → `"policy on remote work"`
3. **Trim** leading/trailing whitespace
4. **Collapse** multiple spaces to single space
5. **SHA-256** hash the result → use as `{normalizedHash}`

This means `"Policy on remote work?"`, `"policy on remote work"`, and `"policy on remote work ?"` all produce the **same cache key**.

---

## Plugin Operations

### `memory_save(content, memory_type, company_id)`

Persists a memory entry to PostgreSQL and updates Redis cache.

```
1. PostgreSQL UPSERT into v1.thannong_ai_openclaw_agent_memory
   ON CONFLICT (id, company_id) DO UPDATE SET content_text, embedding, updated_date

2. Redis SET key = ThanNongAI:company:{cid}:openclaw:{type}

3. Redis DEL openclaw:search:* for that {cid}
   (evict stale search results)

4. Async: generate embedding via OpenAI text-embedding-3-small → store in same row
```

### `memory_search(query, company_id)`

Performs semantic search on bot memory with Redis caching.

```
1. Normalize query: lowercase → strip .?!,;: → trim → collapse spaces → SHA-256
2. Redis GET ThanNongAI:company:{cid}:openclaw:search:{hash}
   HIT → return cached results (~1ms)
3. MISS → pgvector HNSW similarity search:
   SELECT content_text, 1 - (embedding <=> $1) AS similarity
   FROM v1.thannong_ai_openclaw_agent_memory
   WHERE company_id = $2 AND status = 1
   ORDER BY embedding <=> $1 LIMIT 5
4. Cache results in Redis (TTL 5m)
5. Return top-K results
```

### `startup_load(company_id)`

Loads memory context when a new chat session starts.

```
1. Check Redis: ThanNongAI:company:{cid}:openclaw:long_term
   HIT → warm context immediately
2. MISS → SELECT FROM v1.thannong_ai_openclaw_agent_memory
   WHERE company_id = $1 AND memory_type = 'long_term' AND status = 1
3. Also load: today + yesterday daily_note rows
4. Warm Redis keys with loaded content for fast access during session
```

---

## Distinction from Knowledge Base Table

| Table | Purpose | Written By |
|-------|---------|------------|
| `thannong_ai_company_vector_embeddings` | Company **KNOWLEDGE BASE** — products, FAQs, orders, documents | iAttendance app / admin ingestion |
| `thannong_ai_openclaw_agent_memory` | Bot's **OWN LEARNED MEMORY** — decisions, facts, conversation highlights | OpenClaw bot itself during chat (this plugin) |

---

## OpenClaw Configuration

In `openclaw.json`, set the memory plugin slot to use this plugin:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-pg-redis"
    }
  }
}
```

After plugin activation:
- ❌ No `MEMORY.md` files written to local disk
- ❌ No daily note `.md` files written to local disk
- ❌ No SQLite vector index files on local disk
- ✅ All memory operations go through PostgreSQL (source of truth) + Redis (hot cache)

---

## Integration with iAttendance Platform

This plugin is part of the **Thần Nông AI** module in the iAttendance platform. It runs inside the OpenClaw bot pod deployed on DigitalOcean Kubernetes.

### System Context

```
                ┌──────────────────────────────────────────────┐
                │        DigitalOcean Kubernetes Cluster        │
                │                                              │
    Internet    │  ┌─────────────┐  ClusterIP  ┌─────────────┐│
       │        │  │ iAttendance │──(internal)─▶│ OpenClaw    ││
       ▼        │  │  App Pods   │  :3000       │ Bot Pod     ││
  ┌─────────┐   │  │  (2-4x)     │              │             ││
  │ Ingress  │──┼─▶│  :9090      │              │ ┌─────────┐ ││
  │  NGINX   │  │  └──────┬──────┘              │ │memory-  │ ││
  └─────────┘   │         │                     │ │pg-redis │ ││
                │         │                     │ │(MCP-16) │ ││
                │         ▼                     │ └────┬────┘ ││
                │  ┌────────────────────────────┤      │      ││
                │  │  Shared Infrastructure     │      │      ││
                │  │  • PostgreSQL + pgvector ◀──┼──────┘      ││
                │  │  • Redis (hot cache)     ◀──┼──────┘      ││
                │  │  • RabbitMQ                 │              ││
                │  └────────────────────────────┘──────────────┘│
                └──────────────────────────────────────────────┘
```

### Lifecycle

| Event | Action |
|-------|--------|
| Bot writes memory | `memory_save` → PostgreSQL UPSERT + Redis SET + evict search cache |
| Bot searches memory | `memory_search` → normalize → Redis cache check → pgvector HNSW fallback |
| Pod startup | `startup_load` → Redis check → PostgreSQL fallback → warm Redis |
| Daily note > 90 days old | Scheduler soft-deletes (`status=0`) + evicts Redis key |
| Company deleted | FK `ON DELETE CASCADE` removes all rows automatically |
| Redis key expires | Auto-expire: `daily:` 24h, `session:` 1h, `search:` 5m |
| Redis miss on read | Always fall back to PostgreSQL — never return empty without checking DB |

---

## Multi-Pod Consistency

```
Pod A writes memory_save("new fact", "long_term", "COMP-001")
    │
    ├── 1. PostgreSQL UPSERT (sync, durable — survives pod restarts)
    ├── 2. Redis SET (sync — all pods see immediately via shared Redis)
    └── 3. Redis DEL search cache (evict stale results)

Pod B calls memory_search("what did I learn?", "COMP-001")
    │
    ├── 1. Normalize query → SHA-256
    ├── 2. Redis GET search cache → MISS (evicted by Pod A's write)
    ├── 3. pgvector HNSW search → finds "new fact" from Pod A
    └── 4. Cache result for next time (TTL 5m)
```

**No race conditions**: Redis `SET` is atomic; PostgreSQL uses `UPSERT` (`ON CONFLICT DO UPDATE`).

---

## Scaling

| Concern | Status |
|---------|--------|
| Multi-pod memory sharing | ✅ All pods read/write same PostgreSQL + Redis |
| Race conditions | ✅ None — atomic operations throughout |
| Horizontal scaling | ✅ Hash partitioned × 8 — can grow to millions of rows |
| Pod restart recovery | ✅ `startup_load` re-warms Redis from PostgreSQL automatically |
| Database growth | ✅ ~500 rows/company × 5,000 companies = ~2.5M rows → 8 partitions = ~312K each |

---

## Tech Stack

| Technology | Role | Version |
|-----------|------|---------|
| **PostgreSQL** | Durable memory storage (source of truth) | Managed by DigitalOcean |
| **pgvector** | Vector similarity search (HNSW indexes) | v0.8.2 (`pgvector/pgvector:pg18`) |
| **Redis** | Hot cache for fast memory access | Managed by DigitalOcean |
| **OpenAI Embeddings** | `text-embedding-3-small` (1536 dimensions) | API |
| **Node.js / TypeScript** | Plugin runtime | 18+ |
| **OpenClaw** | Bot framework (memory plugin slot) | Latest |

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Detailed architecture design — data flow, caching strategy, security model |
| `MenuThanNongAiCompany_SKILL.md` | Full module specification — bot API, MCP tools, caching, security, UI design |
| `MenuThanNongAiCompany_architecture.md` | Module architecture — DB schema, code-flow diagrams, Redis caching, pgvector |
| `MenuThanNongAiCompany_Openclaw_Bot.md` | Kubernetes deployment guide — Deployment, Service, Secrets, docker-compose |
| `v1.thannong_ai_company_openclaw_agent_memory.sql` | SQL migration file — table, partitions, indexes, FK, example queries |

---

## License

See [LICENSE](./LICENSE) for details.
