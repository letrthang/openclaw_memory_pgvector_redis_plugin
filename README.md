# OpenClaw Memory Plugin — PostgreSQL (pgvector) + Redis

**Plugin version: `0.1.0`** · **Plugin name: `memory-pgvector-redis`** · **Author: [Thang Le](https://github.com/letrthang)**

[![GitHub](https://img.shields.io/badge/GitHub-openclaw__memory__pgvector__redis__plugin-blue?logo=github)](https://github.com/letrthang/openclaw_memory_pgvector_redis_plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> **MCP-16** — Custom OpenClaw memory plugin that replaces file-based memory with PostgreSQL + pgvector for durable shared storage and Redis for hot caching. Designed for multi-pod Kubernetes deployments with strict tenant isolation. This plugin is primarily built to serve **MCP-16** of the main project [**Thần Nông AI**](https://github.com/letrthang).

---

## Overview

This project implements a **custom OpenClaw memory plugin** (`memory-pgvector-redis`) that replaces OpenClaw's default file-based memory system (`MEMORY.md`, daily notes `.md` files, and per-pod SQLite vector index) with a shared **PostgreSQL + Redis** backend.

### Why This Plugin Exists

OpenClaw's default memory system writes files to the pod's local filesystem:
- `MEMORY.md` — long-term facts and decisions
- `memory/YYYY-MM-DD.md` — daily running context
- SQLite vector index — per-pod semantic search

**In Kubernetes multi-pod deployments, this breaks.** Each pod has its own filesystem — memory diverges across pods. Pod A learns something that Pod B never sees. Syncing via S3 introduces race conditions (last-write-wins).

This plugin solves the problem by:
- Storing all memory in **PostgreSQL** (source of truth) with **pgvector** for semantic search
- Using **Redis** as a hot cache for fast reads during the agent loop
- Enforcing **`tenant_id` isolation** in every query — baked into the plugin code, not the LLM prompt
- Supporting **multi-pod shared memory** with atomic upserts — no race conditions

### What This Plugin Is NOT

- **NOT** a third-party plugin — we rejected `openclaw-redis-agent-memory`, `openclaw-memory-pgvector`, and `mem0` because none provide `tenant_id` isolation
- **NOT** a general-purpose vector store — that's for your knowledge base (e.g., products, FAQs, documents). This plugin manages the **bot's own learned memory** only
- **NOT** a replacement for the RAG pipeline — embedding ingestion for domain knowledge is handled separately, which is **MCP-14** in Thần Nông AI


### Generic Tenant Model

This plugin uses **`tenant_id`** as a generic isolation key. It can represent any entity that owns memory:

| Use Case | `tenant_id` represents |
|----------|----------------------|
| B2B SaaS platform | `company_id` — each company has its own bot memory |
| Customer portal | `customer_id` — each customer has isolated memory |
| Admin portal | `admin_user_id` — per-admin memory context |
| Multi-org platform | `org_id` — organizational boundary |
| Personal assistant | `user_id` — per-user private memory |

The plugin does not interpret `tenant_id` — it treats it as an opaque string for isolation. The calling application is responsible for mapping its domain entity to `tenant_id`.

---

## How to Deploy This Plugin

This section describes how to deploy the `memory-pgvector-redis` plugin into an OpenClaw bot instance. The plugin is listed on the **[OpenClaw Directory](https://openclawdir.com/)** — the official plugin registry for OpenClaw.

### Prerequisites

| Requirement | Details |
|-------------|---------|
| **OpenClaw bot** | Running instance with plugin slot support. See [openclawdir.com](https://openclawdir.com/) for setup guides. |
| **PostgreSQL 18+** | With `pgvector` extension enabled (`CREATE EXTENSION IF NOT EXISTS vector;`) |
| **Redis 8+** | Managed or self-hosted, SSL recommended |
| **Node.js 22+ LTS** | Plugin runtime |
| **OpenAI API key** | For `text-embedding-3-small` embedding generation |

### Step 1 — Create the Database Table

Run the SQL migration to create the memory table and its partitions. Use the table name you want (default: `v1.openclaw_agent_memory`).

```bash
# Apply the migration file
psql $DATABASE_URL -f src/main/resources/db/migration/dev/v1.openclaw_agent_memory.sql
```

> If using a custom table name, replace `v1.openclaw_agent_memory` in the migration file before running.

Verify the table and indexes exist:
```sql
\dt+ v1.openclaw_agent_memory*
\di+ *openclaw*
```

### Step 2 — Install the Plugin

#### Option A: Install from OpenClaw Directory (recommended)

Install directly from the [OpenClaw Directory](https://openclawdir.com/):

```bash
# Install the plugin via OpenClaw CLI
openclaw plugin install memory-pgvector-redis
```

> Visit the plugin page at [openclawdir.com/plugins/memory-pgvector-redis](https://openclawdir.com/plugins/memory-pgvector-redis) for the latest version and installation instructions.
>
> **TODO**: Update the exact CLI command and directory URL once the plugin is published to openclawdir.com.

#### Option B: Install from GitHub (manual)

```bash
# Clone the plugin repository
git clone https://github.com/letrthang/openclaw_memory_pgvector_redis_plugin.git

# Install dependencies
cd openclaw_memory_pgvector_redis_plugin
npm install

# Build
npm run build
```

Then copy the built plugin into your OpenClaw bot's plugin directory:

```bash
# The exact path depends on your OpenClaw installation
cp -r dist/ /path/to/openclaw-bot/plugins/memory-pgvector-redis/
cp package.json /path/to/openclaw-bot/plugins/memory-pgvector-redis/
```

> **TODO**: Update exact path and copy instructions once plugin structure is finalized per [openclawdir.com](https://openclawdir.com/) conventions.

### Step 3 — Configure Environment Variables

Set the required environment variables. For Kubernetes, use Secrets and ConfigMaps. For local dev, use a `.env` file.

**Required:**
```env
DATABASE_URL=postgresql://user:pass@host:25061/db?sslmode=require
REDIS_URL=rediss://user:pass@host:25061
OPENAI_API_KEY=sk-...
```

**Optional (defaults shown):**
```env
TENANCY_NAME=COMPANY
DB_TABLE_NAME=v1.openclaw_agent_memory
REDIS_KEY_PREFIX=openclaw:memory
```

See [Plugin Configuration](#plugin-configuration) for full details on each parameter.

### Step 4 — Activate the Plugin in OpenClaw

Edit your `openclaw.json` to register the memory plugin:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-pgvector-redis"
    }
  }
}
```

This tells OpenClaw to:
- ❌ Disable default file-based memory (`MEMORY.md`, daily notes, SQLite)
- ✅ Route all memory operations through this plugin

> For more details on plugin slots, see the [OpenClaw plugin documentation](https://openclawdir.com/docs/plugins).

### Step 5 — (Optional) Add Foreign Key Constraint

If your application has a tenant table, add a FK for automatic cascade deletion:

```sql
-- Example: tenant_id references a companies table
ALTER TABLE v1.openclaw_agent_memory
ADD CONSTRAINT fk_tenant
FOREIGN KEY (tenant_id) REFERENCES v1.companies(id) ON DELETE CASCADE;
```

### Step 6 — Start the Bot

```bash
# Start OpenClaw bot (method depends on your deployment)
# Local:
openclaw start
# or:
npm start

# Kubernetes:
kubectl rollout restart deployment/openclaw-bot
```

On startup, the plugin will:
1. Connect to PostgreSQL and Redis
2. Log: `memory-pgvector-redis@0.1.0 initialized — tenancy=COMPANY, table=v1.openclaw_agent_memory`
3. Call `startup_load(tenant_id)` on the first session to warm the Redis cache

### Step 7 — Verify

**Check the startup logs:**
```
memory-pgvector-redis@0.1.0 initialized — tenancy=COMPANY, table=v1.openclaw_agent_memory
  ✓ PostgreSQL connected
  ✓ Redis connected
  ✓ Hunspell dictionaries loaded (en_US + vi_VN)
```

**Check the health endpoint:**
```bash
curl http://localhost:3000/health
```
```json
{
  "plugin": "memory-pgvector-redis",
  "version": "0.1.0",
  "tenancy": "COMPANY",
  "status": "healthy",
  "postgresql": "connected",
  "redis": "connected"
}
```

**Test memory operations** (via chat):
1. Tell the bot something: _"Remember that our support hours are 9am-5pm"_
2. In a new session, ask: _"What are our support hours?"_
3. The bot should recall the information from PostgreSQL/Redis — not local files

**Verify in database:**
```sql
SELECT id, tenant_id, memory_type, content_text, status
FROM v1.openclaw_agent_memory
WHERE tenant_id = 'your-tenant-id'
ORDER BY created_date DESC LIMIT 5;
```

**Verify in Redis:**
```bash
redis-cli KEYS "openclaw:memory:*"
```

### Deployment Checklist

| # | Step | Status |
|---|------|--------|
| 1 | pgvector extension enabled | ☐ |
| 2 | Memory table + partitions + indexes created | ☐ |
| 3 | Plugin installed (via [openclawdir.com](https://openclawdir.com/) or GitHub) | ☐ |
| 4 | `DATABASE_URL`, `REDIS_URL`, `OPENAI_API_KEY` set | ☐ |
| 5 | `openclaw.json` updated with `"memory": "memory-pgvector-redis"` | ☐ |
| 6 | (Optional) FK constraint added | ☐ |
| 7 | Bot started, startup log shows plugin initialized | ☐ |
| 8 | Health check returns `"status": "healthy"` | ☐ |
| 9 | Memory save + search tested via chat | ☐ |
| 10 | Verified rows in PostgreSQL and keys in Redis | ☐ |

> **Note**: Some details (exact CLI commands, directory URLs, plugin registration mechanism) will be updated once the plugin is published to [openclawdir.com](https://openclawdir.com/) and the implementation is complete.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Durable Memory** | PostgreSQL as source of truth — survives pod restarts, scaling events, and rolling updates |
| **Fast Reads** | Redis hot cache with structured key patterns — sub-millisecond memory access during agent loop |
| **Semantic Search** | pgvector HNSW indexes for ANN similarity search on memory content |
| **Tenant Isolation** | Every query includes `WHERE tenant_id = $1` — hardcoded in plugin code, not LLM prompt |
| **Multi-Pod Safe** | All pods read/write the same PostgreSQL + Redis — atomic upserts, no split-brain |
| **Zero Local Disk** | No `MEMORY.md`, no `.md` files, no SQLite — nothing written to local filesystem |
| **Query Normalization** | Search cache uses normalized-query SHA-256 keys — `"Policy on remote work?"` and `"policy on remote work"` hit the same cache |

---

## Architecture

```
OpenClaw Bot Pod (any of N replicas)
    │
    ├── memory_save(content, memory_type, tenant_id)
    │   ├── 1. PostgreSQL UPSERT (sync, durable — source of truth)
    │   ├── 2. Redis SET (sync — update hot cache)
    │   ├── 3. Redis DEL search cache (evict stale search results)
    │   └── 4. Async: generate embedding → store in same row
    │
    ├── memory_search(query, tenant_id)
    │   ├── 1. Normalize query → SHA-256 hash
    │   ├── 2. Redis GET search cache → HIT: return (~1ms)
    │   ├── 3. MISS: pgvector HNSW search on PostgreSQL
    │   ├── 4. Cache result in Redis (TTL 5m)
    │   └── 5. Return top-K results
    │
    └── startup_load(tenant_id)
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

### Table: `{DB_TABLE_NAME}` (default: `v1.openclaw_agent_memory`)

The table name is configurable via the `DB_TABLE_NAME` env var. This allows multiple plugin instances to use separate tables (e.g., `openclaw_agent_memory_company`, `openclaw_agent_memory_customer`).

**Partitioning**: `HASH(tenant_id)` × 8 partitions
**PK**: `(id, tenant_id)` — PostgreSQL requires partition key in compound PK
**FK**: Configurable — the calling application can add FK constraints to its own tenant table (e.g., `tenant_id → companies(id)` or `tenant_id → users(id)`)

| Column | Type | Description |
|--------|------|-------------|
| `id` | `varchar` (PK) | UUID — unique memory row identifier |
| `tenant_id` | `varchar` (PK, partition key) | Opaque tenant isolation key — can be company_id, user_id, customer_id, etc. **Mandatory in every WHERE clause** |
| `memory_type` | `varchar(50)` | `'long_term'`, `'daily_note'`, or `'session'` |
| `content_text` | `text` | Raw memory content — human-readable, inspectable |
| `embedding` | `vector(1536)` | OpenAI `text-embedding-3-small` output. Cosine distance via `<=>` |
| `memory_date` | `date` (nullable) | For `daily_note`: which calendar day (UTC). NULL for other types |
| `status` | `int4` (default 1) | `1`=ACTIVE, `0`=DELETED (soft-delete) |
| `created_date` | `timestamp` | Row creation time (UTC) |
| `updated_date` | `timestamp` | Last update time (UTC) |

### Why `tenant_id`? — Explained with Table Rows

In real-world deployments, a single bot instance serves **many different entities** — companies, customers, users, etc. The `tenant_id` column ensures every row belongs to exactly one tenant. Without it, all memory would be mixed together:

```
❌ WITHOUT tenant_id — all rows in one big pool, no isolation:

    id       | content_text                              | memory_type
    ─────────┼───────────────────────────────────────────┼────────────
    uuid-1   | "Company A prefers formal tone"           | long_term
    uuid-2   | "Company B wants casual, emoji-heavy"     | long_term
    uuid-3   | "Customer C is allergic to peanuts"       | long_term

    → Bot searches for tone preference → gets BOTH Company A and B results
    → Bot searches for dietary info → leaks Customer C's data to everyone
    → PRIVACY VIOLATION + WRONG ANSWERS
```

With `tenant_id`, the same table is **logically partitioned per tenant**:

```
✅ WITH tenant_id — every row is scoped to its owner:

    id       | tenant_id  | content_text                          | memory_type
    ─────────┼────────────┼───────────────────────────────────────┼────────────
    uuid-1   | COMP-A     | "prefers formal tone"                 | long_term
    uuid-2   | COMP-B     | "wants casual, emoji-heavy replies"   | long_term
    uuid-3   | CUST-C     | "allergic to peanuts"                 | long_term
    uuid-4   | COMP-A     | "discussed Q2 roadmap with CEO"       | daily_note
    uuid-5   | CUST-C     | "asked about gluten-free menu"        | daily_note

    → Company A asks about tone:
      SELECT ... WHERE tenant_id='COMP-A' → only "prefers formal tone" ✅

    → Company B asks about tone:
      SELECT ... WHERE tenant_id='COMP-B' → only "wants casual, emoji-heavy" ✅

    → Customer D asks about dietary info:
      SELECT ... WHERE tenant_id='CUST-D' → finds nothing (correct! D has no memory yet) ✅

    → Customer C's allergy info is NEVER visible to anyone else ✅
```

**Simple rule**: every SQL query includes `WHERE tenant_id = $1`, and every Redis key includes `{tenant_id}`. No exceptions. This is enforced in the plugin code — not by the LLM prompt, not by the caller.

#### Real-World Examples

| Scenario | Without `tenant_id` | With `tenant_id` |
|----------|---------------------|-------------------|
| **Company A** bot learns "our refund policy is 30 days" | All companies see this refund policy | Only Company A's bot remembers this |
| **Customer X** tells bot "I prefer Vietnamese language" | All customers get Vietnamese replies | Only Customer X gets Vietnamese replies |
| **Admin Y** saves a note "escalate billing issues to John" | All admins see this note | Only Admin Y's context includes this |
| **User Z** asks bot to "remember my birthday is March 5" | Everyone's bot knows User Z's birthday | Only User Z's bot knows this |

### Indexes (4 per partition × 8 = 32 total)

| # | Index Type | Columns | Purpose |
|---|-----------|---------|---------|
| 1 | B-tree | `(tenant_id, memory_type)` | Filter by memory type |
| 2 | B-tree partial | `(tenant_id) WHERE status = 1` | Active-only queries |
| 3 | B-tree | `(tenant_id, memory_date)` | Daily note date lookup |
| 4 | HNSW | `embedding (vector_cosine_ops) m=16, ef_construction=64` | ANN semantic search |

### SQL Migration

The full migration file is at:
```
src/main/resources/db/migration/dev/v1.openclaw_agent_memory.sql
```

**Prerequisite**: pgvector extension must be enabled:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## Redis Key Patterns

All Redis keys use a **configurable prefix** set via the `REDIS_KEY_PREFIX` environment variable. This prevents key collisions when multiple plugin instances (e.g., company bot + customer portal) share the same Redis database.

| Environment Variable | Default | Example Values |
|---------------------|---------|----------------|
| `REDIS_KEY_PREFIX` | `openclaw:memory` | `thannong:company`, `portal:customer`, `admin:user` |

### Key Structure: `{REDIS_KEY_PREFIX}:{tenant_id}:{key_type}`

| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `{prefix}:{tid}:long_term` | No TTL | Durable long-term memory (replaces MEMORY.md) |
| `{prefix}:{tid}:daily:{date}` | 24h | Daily note context (auto-expires) |
| `{prefix}:{tid}:session:{sid}` | 1h | Session highlights (short-lived) |
| `{prefix}:{tid}:search:{normalizedHash}` | 5m | Cached `memory_search` results |

> **`{prefix}`** = value of `REDIS_KEY_PREFIX` env var. **`{tid}`** = the `tenant_id` value.

### Why Configurable Prefix Matters

If two plugin instances share the same Redis DB with the default prefix, a company with ID `"123"` and a user with ID `"123"` would collide:

```
# ❌ COLLISION — both resolve to the same key
openclaw:memory:123:long_term   ← company bot (tenant_id = company "123")
openclaw:memory:123:long_term   ← customer portal (tenant_id = user "123")

# ✅ NO COLLISION — different prefixes
thannong:company:123:long_term  ← company bot (REDIS_KEY_PREFIX=thannong:company)
portal:customer:123:long_term   ← customer portal (REDIS_KEY_PREFIX=portal:customer)
```

### Query Normalization (for search cache keys)

To increase cache hit rate, search queries are normalized before hashing. This ensures that different phrasings of the same question — including **typos** — produce the **same Redis cache key**.

**Normalization steps (in order):**

| Step | Operation | Example |
|------|-----------|---------|
| 1 | **Strip punctuation** — remove `.?!,;:'"()[]{}` from head, tail, and body | `" Wht is   Thần Nông AI platform ?"` → `" Wht is   Thần Nông AI platform "` |
| 2 | **Trim** — remove leading/trailing whitespace | → `"Wht is   Thần Nông AI platform"` |
| 3 | **Lowercase** — all characters to lowercase | → `"wht is   thần nông ai platform"` |
| 4 | **Remove accents** — strip Vietnamese (and other) diacritics | → `"wht is   than nong ai platform"` |
| 5 | **Spell correction** — fix common typos using local Hunspell dictionaries (en_US + vi_VN, no AI, no API calls) | → `"what is   than nong ai platform"` |
| 6 | **Collapse whitespace** — replace multiple consecutive spaces with single space | → `"what is than nong ai platform"` |
| 7 | **SHA-256 hash** — hash the normalized string → use as `{normalizedHash}` | → `"b7e9f2a1..."` |

**Full example (with typo):**

```
Input A:  " Wht is   Thần Nông AI platform ?"     ← typo: "Wht" instead of "What"
Input B:  "What is   Thần Nông AI platform."       ← correct spelling
Input C:  "what is than nong ai platform"          ← already normalized
Input D:  "  WHAT  IS  THẦN  NÔNG  AI  PLATFORM  ?  "

All four normalize to the same string:
  → "what is than nong ai platform"

All four produce the same SHA-256 hash:
  → same Redis key: {prefix}:{tid}:search:b7e9f2a1...
  → cache HIT on subsequent queries ✅
```

**Step 5 — Spell Correction Libraries (local, no AI):**

The spell correction step uses **local Hunspell dictionaries** — no API calls, no token cost, runs entirely in-process. The plugin loads **both English and Vietnamese** dictionaries and checks each word against both.

**Recommended libraries for Node.js:**

| Library | Description | Install |
|---------|-------------|---------|
| **[nspell](https://github.com/wooorm/nspell)** | Hunspell-compatible spell checker. Supports `.dic` + `.aff` dictionary files. Lightweight, fast. | `npm install nspell` |
| **[nodehun](https://github.com/nathanjsweet/nodehun)** | Native Node.js bindings to Hunspell C++ library. Faster for high-throughput, same dictionary format. | `npm install nodehun` |
| **[typo-js](https://github.com/cfinke/Typo.js)** | Pure JavaScript Hunspell implementation. Works in browser and Node.js. No native deps. | `npm install typo-js` |

**Dictionaries (English + Vietnamese):**

| Dictionary | Package / Source | Language |
|-----------|-----------------|----------|
| `en_US` | `npm install dictionary-en` | English (US) |
| `vi_VN` | [LibreOffice Vietnamese dictionary](https://github.com/LibreOffice/dictionaries/tree/master/vi) — download `.dic` + `.aff` files | Vietnamese |

> **Note**: Vietnamese Hunspell dictionaries are not published on npm. Download the `vi_VN.dic` and `vi_VN.aff` files from the LibreOffice dictionaries repo and bundle them with the plugin (e.g., in `src/dictionaries/vi_VN/`).

**How it works (dual-language):**
```
# Load both dictionaries at startup
enSpell = nspell(en_US_aff, en_US_dic)
viSpell = nspell(vi_VN_aff, vi_VN_dic)

# For each word, check both dictionaries:
word = "wht"
enSpell.correct("wht")  → false
viSpell.correct("wht")  → false
# Neither recognizes it → check English suggestions first:
enSpell.suggest("wht")  → ["what", "whet", "whit"]
Pick first suggestion   → "what"

word = "xin"
enSpell.correct("xin")  → false
viSpell.correct("xin")  → true   ← valid Vietnamese word, keep as-is ✅

word = "chào"            → after accent removal in step 4, becomes "chao"
enSpell.correct("chao")  → false
viSpell.correct("chao")  → true   ← valid Vietnamese (without accent), keep as-is ✅

No AI. No API call. ~0.1ms per word. Runs locally.
```

**Language detection logic:**
1. Check if word is valid in **Vietnamese** dictionary → if yes, keep as-is (skip correction)
2. Check if word is valid in **English** dictionary → if yes, keep as-is
3. If invalid in both → get suggestions from **English** first, then **Vietnamese**
4. Pick the top suggestion with highest confidence → apply correction
5. If no clear suggestion from either → keep original word

**Important caveats:**
- Spell correction is **per-word**, not grammar-level. `"wht is"` → `"what is"` ✅, but it won't restructure sentences.
- Only correct words that have a **single clear suggestion**. If ambiguous (multiple equally likely corrections), keep the original word to avoid false normalization.
- Use a **pinned dictionary version** in `package.json` to ensure deterministic corrections across deployments. Different dictionary versions may suggest different words → different hashes → cache miss.
- Domain-specific terms (e.g., `"pgvector"`, `"OpenClaw"`) should be added to a **custom dictionary** to avoid false corrections.

**Why accent removal matters**: Vietnamese users may type with or without diacritics. `"Thần Nông"` and `"Than Nong"` should hit the same cache. The normalization converts `ầ→a`, `ô→o`, `ồ→o`, etc. using Unicode NFD decomposition + strip combining characters.

**Redis key example:**

```
REDIS_KEY_PREFIX = thannong:company
tenant_id        = 123
query            = " Wht is   Thần Nông AI platform ?"
after steps 1-4  = "wht is   than nong ai platform"
after step 5     = "what is   than nong ai platform"    ← "wht" → "what" (spell fix)
after step 6     = "what is than nong ai platform"
hash             = SHA-256("what is than nong ai platform") = "b7e9f2a1..."

Final Redis key  = thannong:company:123:search:b7e9f2a1...
```

---

## Plugin Operations

### `memory_save(content, memory_type, tenant_id)`

Persists a memory entry to PostgreSQL and updates Redis cache.

```
1. PostgreSQL UPSERT into {table}
   ON CONFLICT (id, tenant_id) DO UPDATE SET content_text, embedding, updated_date

2. Normalize content using the same 7-step pipeline as memory_search:
   strip punctuation → trim → lowercase → remove accents → collapse whitespace → SHA-256
   This produces the {normalizedHash} for the Redis cache key.

3. Redis SET key = {prefix}:{tid}:{type}
   (update the memory-type cache — long_term, daily_note, or session)

4. Redis SET key = {prefix}:{tid}:search:{normalizedHash}
   (pre-warm search cache so the next memory_search for this content is a HIT)

5. Redis DEL {prefix}:{tid}:search:* (EXCEPT the key just written in step 4)
   (evict stale search results that may return outdated content)

6. Async: generate embedding via OpenAI text-embedding-3-small → store in same row
```

> **Why normalize on save?** If the bot saves `"Thần Nông AI prefers formal tone"` and the user later searches `"than nong ai formal tone"`, both go through the same normalization pipeline → same hash → cache HIT.

### `memory_search(query, tenant_id)`

Performs semantic search on bot memory with Redis caching.

```
1. Normalize query using the 7-step pipeline:
   strip punctuation → trim → lowercase → remove accents → collapse whitespace → SHA-256
   → produces {normalizedHash}
2. Redis GET {prefix}:{tid}:search:{normalizedHash}
   HIT → return cached results (~1ms)
3. MISS → pgvector HNSW similarity search:
   SELECT content_text, 1 - (embedding <=> $1) AS similarity
   FROM {table}
   WHERE tenant_id = $2 AND status = 1
   ORDER BY embedding <=> $1 LIMIT 5
4. Cache results in Redis (TTL 5m)
5. Return top-K results
```

### `startup_load(tenant_id)`

Loads memory context when a new chat session starts.

```
1. Check Redis: {prefix}:{tid}:long_term
   HIT → warm context immediately
2. MISS → SELECT FROM {table}
   WHERE tenant_id = $1 AND memory_type = 'long_term' AND status = 1
3. Also load: today + yesterday daily_note rows
4. Warm Redis keys with loaded content for fast access during session
```

---

## Distinction from Knowledge Base Table

This plugin manages the **bot's own learned memory** — not domain knowledge. If your application has a separate knowledge base (products, FAQs, documents), that is a different concern:

| Table | Purpose | Written By |
|-------|---------|------------|
| Your knowledge base table | Domain data — products, FAQs, orders, documents | Your app / admin ingestion pipeline |
| `openclaw_agent_memory` | Bot's **OWN LEARNED MEMORY** — decisions, facts, conversation highlights | OpenClaw bot itself during chat (this plugin) |

---

## OpenClaw Configuration

In `openclaw.json`, set the memory plugin slot to use this plugin:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-pgvector-redis"
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

## Plugin Configuration

The plugin accepts configuration parameters via environment variables. These allow multiple plugin instances to coexist on the same PostgreSQL database and Redis instance without collisions, and to self-identify what type of tenancy they serve.

| Environment Variable | Required | Default | Description |
|---------------------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `REDIS_URL` | ✅ | — | Redis connection string |
| `OPENAI_API_KEY` | ✅ | — | For embedding generation (`text-embedding-3-small`) |
| `TENANCY_NAME` | ❌ | `COMPANY` | Human-readable label for what `tenant_id` represents in this instance. Used in logs, error messages, and health checks. |
| `REDIS_KEY_PREFIX` | ❌ | `openclaw:memory` | Redis key namespace prefix |
| `DB_TABLE_NAME` | ❌ | `v1.openclaw_agent_memory` | Fully-qualified PostgreSQL table name (schema.table) |

### How The Three Config Params Work Together

| Param | Controls | Example |
|-------|----------|---------|
| `TENANCY_NAME` | **Identity** — what does `tenant_id` mean in this instance? | `COMPANY`, `CUSTOMER`, `USER`, `ORG` |
| `DB_TABLE_NAME` | **Storage** — which PostgreSQL table to read/write | `v1.openclaw_agent_memory_company` |
| `REDIS_KEY_PREFIX` | **Cache** — which Redis key namespace to use | `thannong:company` |

A single project may run **multiple plugin instances** for different entity types — all sharing the same PostgreSQL and Redis:

```
Instance 1: Company bot memory
    TENANCY_NAME=COMPANY
    DB_TABLE_NAME=v1.openclaw_agent_memory_company
    REDIS_KEY_PREFIX=thannong:company

Instance 2: Customer portal memory
    TENANCY_NAME=CUSTOMER
    DB_TABLE_NAME=v1.openclaw_agent_memory_customer
    REDIS_KEY_PREFIX=portal:customer

Instance 3: Admin portal memory
    TENANCY_NAME=ADMIN_USER
    DB_TABLE_NAME=v1.openclaw_agent_memory_admin
    REDIS_KEY_PREFIX=admin:user
```

Each instance has its own table (separate indexes, partitions, FK constraints), its own Redis namespace, and identifies itself clearly in logs. Zero collision risk.

### What `TENANCY_NAME` Is Used For

The plugin does NOT use `TENANCY_NAME` in SQL queries or Redis keys — those use `tenant_id` directly. Instead, `TENANCY_NAME` provides **human-readable context** for:

| Usage | Example Output |
|-------|---------------|
| **Log messages** | `[memory-pgvector-redis@0.1.0][COMPANY] memory_save: tenant_id=COMP-001, type=long_term` |
| **Error messages** | `[memory-pgvector-redis@0.1.0][CUSTOMER] PostgreSQL UPSERT failed for tenant_id=CUST-42` |
| **Health check** | `{ "plugin": "memory-pgvector-redis", "version": "0.1.0", "tenancy": "COMPANY", "status": "healthy" }` |
| **Startup banner** | `memory-pgvector-redis@0.1.0 initialized — tenancy=COMPANY, table=v1.openclaw_agent_memory_company` |

### Configuration Examples

**Single-instance deployment** (simplest — use defaults):
```env
DATABASE_URL=postgresql://user:pass@host:25061/db?sslmode=require
REDIS_URL=rediss://user:pass@host:25061
OPENAI_API_KEY=sk-...
# TENANCY_NAME, DB_TABLE_NAME, and REDIS_KEY_PREFIX use defaults
```

**Multi-instance deployment** (same infra, different entity types):
```env
# === Company Bot ===
DATABASE_URL=postgresql://user:pass@host:25061/db?sslmode=require
REDIS_URL=rediss://user:pass@host:25061
OPENAI_API_KEY=sk-...
TENANCY_NAME=COMPANY
DB_TABLE_NAME=v1.openclaw_agent_memory_company
REDIS_KEY_PREFIX=thannong:company

# === Customer Portal Bot ===
DATABASE_URL=postgresql://user:pass@host:25061/db?sslmode=require
REDIS_URL=rediss://user:pass@host:25061
OPENAI_API_KEY=sk-...
TENANCY_NAME=CUSTOMER
DB_TABLE_NAME=v1.openclaw_agent_memory_customer
REDIS_KEY_PREFIX=portal:customer
```

---

## Integration Example (Thần Nông AI)

> This section shows how the plugin integrates with a specific platform as a reference example.
> Your integration will follow the same pattern — just map your domain entity to `tenant_id`.

This plugin was originally built for the **Thần Nông AI** module. It runs inside the OpenClaw bot pod deployed on DigitalOcean Kubernetes.

### System Context

```
                ┌──────────────────────────────────────────────┐
                │        Kubernetes Cluster                     │
                │                                              │
    Internet    │  ┌─────────────┐  ClusterIP  ┌─────────────┐│
       │        │  │ App Pods    │──(internal)─▶│ OpenClaw    ││
       ▼        │  │  (2-4x)     │  :3000       │ Bot Pod     ││
  ┌─────────┐   │  │  :9090      │              │             ││
  │ Ingress  │──┼─▶│             │              │ ┌─────────┐ ││
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

### Mapping `tenant_id` in Thần Nông AI

In the Thần Nông AI platform, `tenant_id` = `company_id` from `v1.companies(id_company)`. The Java service layer maps this before calling the bot:

```
Spring Boot Session → MainView.companyID → HTTP Header: X-Tenant-ID → plugin uses as tenant_id
```

### Lifecycle

| Event | Action |
|-------|--------|
| Bot writes memory | `memory_save` → PostgreSQL UPSERT + Redis SET + evict search cache |
| Bot searches memory | `memory_search` → normalize → Redis cache check → pgvector HNSW fallback |
| Pod startup | `startup_load` → Redis check → PostgreSQL fallback → warm Redis |
| Daily note > 90 days old | Scheduler soft-deletes (`status=0`) + evicts Redis key |
| Tenant deleted | FK `ON DELETE CASCADE` removes all rows automatically (if FK configured) |
| Redis key expires | Auto-expire: `daily:` 24h, `session:` 1h, `search:` 5m |
| Redis miss on read | Always fall back to PostgreSQL — never return empty without checking DB |

---

## Multi-Pod Consistency

```
Pod A writes memory_save("new fact", "long_term", "TENANT-001")
    │
    ├── 1. PostgreSQL UPSERT (sync, durable — survives pod restarts)
    ├── 2. Redis SET (sync — all pods see immediately via shared Redis)
    └── 3. Redis DEL search cache (evict stale results)

Pod B calls memory_search("what did I learn?", "TENANT-001")
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
| Database growth | ✅ ~500 rows/tenant × 5,000 tenants = ~2.5M rows → 8 partitions = ~312K each |

---

## Tech Stack

| Technology | Role | Version |
|-----------|------|---------|
| **PostgreSQL** | Durable memory storage (source of truth) | 18.x (DigitalOcean Managed) |
| **pgvector** | Vector similarity search (HNSW indexes) | v0.8.x (`pgvector/pgvector:pg18`) |
| **Redis (KeyVal)** | Hot cache for fast memory access | 8.x (DigitalOcean Managed KeyVal) |
| **OpenAI Embeddings** | `text-embedding-3-small` (1536 dimensions) | API |
| **Node.js / TypeScript** | Plugin runtime | 22.x LTS |
| **OpenClaw** | Bot framework (memory plugin slot) | Latest |

---

## Versioning

This plugin follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`):

| Version Part | When to Bump | Example |
|-------------|-------------|---------|
| **MAJOR** | Breaking changes — schema migration required, config param renamed/removed, API signature changed | `0.x.x` → `1.0.0` |
| **MINOR** | New features, backward-compatible — new config param, new memory_type, new optional field | `0.1.0` → `0.2.0` |
| **PATCH** | Bug fixes, performance improvements — no schema or API changes | `0.1.0` → `0.1.1` |

The plugin reads its version from `package.json` at startup and includes it in:
- **Startup banner** — logged on initialization
- **Health check response** — `GET /health` returns `{ "version": "0.1.0", ... }`
- **Log prefix** — every log line includes `memory-pgvector-redis@{version}`

### Current Version

```
0.1.0 — Initial design and architecture (pre-release)
```

### Changelog

| Version | Date | Changes |
|---------|------|---------|
| `0.1.0` | 2026-04-14 | Initial architecture — README, ARCHITECTURE.md, schema design, configurable `TENANCY_NAME` / `DB_TABLE_NAME` / `REDIS_KEY_PREFIX` |

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Detailed architecture design — data flow, caching strategy, security model |

---

## License

MIT License © 2026 [Thang Le](https://github.com/letrthang)

See [LICENSE](./LICENSE) for full text.
