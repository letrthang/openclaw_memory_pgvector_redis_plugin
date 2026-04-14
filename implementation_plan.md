# Implementation Plan — OpenClaw Memory Plugin (memory-pgvector-redis)

**Created**: 2026-04-14
**Status**: Implementation in progress
**Total files to create**: 29 (18 source + 1 SQL migration + 4 config + 6 test)

---

## Table of Contents

1. [File Structure Tree](#file-structure-tree)
2. [Implementation Steps](#implementation-steps)
3. [Detailed File Descriptions](#detailed-file-descriptions)
4. [PostgreSQL Pool Retry Strategy](#postgresql-pool-retry-strategy)
5. [Exception Handling Patterns](#exception-handling-patterns)
6. [Dependencies](#dependencies)

---

## File Structure Tree

```
openclaw_memory_pgvector_redis_plugin/
├── tsconfig.json
├── jest.config.ts
├── .eslintrc.json
├── .env.example
├── src/
│   ├── index.ts
│   ├── config/
│   │   └── env.ts
│   ├── db/
│   │   ├── pool.ts
│   │   └── queries.ts
│   ├── cache/
│   │   ├── redisClient.ts
│   │   └── cacheService.ts
│   ├── embedding/
│   │   └── openaiEmbedding.ts
│   ├── normalization/
│   │   ├── pipeline.ts
│   │   ├── spellCorrector.ts
│   │   └── accentRemover.ts
│   ├── operations/
│   │   ├── memorySave.ts
│   │   ├── memorySearch.ts
│   │   └── startupLoad.ts
│   ├── health/
│   │   └── healthCheck.ts
│   ├── errors/
│   │   └── pluginErrors.ts
│   ├── types/
│   │   └── index.ts
│   ├── utils/
│   │   └── logger.ts
│   └── dictionaries/
│       └── vi_VN/
│           ├── vi_VN.aff
│           └── vi_VN.dic
├── src/main/resources/db/migration/dev/
│   └── v1.openclaw_agent_memory.sql
└── tests/
    ├── unit/
    │   ├── normalization.test.ts
    │   ├── cacheService.test.ts
    │   └── pluginErrors.test.ts
    ├── integration/
    │   ├── memorySave.test.ts
    │   └── memorySearch.test.ts
    └── e2e/
        └── healthCheck.test.ts
```

---

## Implementation Steps

| Step | Files | Description |
|------|-------|-------------|
| 1 | `tsconfig.json`, `jest.config.ts`, `.eslintrc.json`, `.env.example` | Project config files |
| 2 | `package.json` (update) | Install all npm dependencies |
| 3 | `src/config/env.ts`, `src/types/index.ts`, `src/utils/logger.ts`, `src/errors/pluginErrors.ts` | Core infrastructure layer |
| 4 | `src/db/pool.ts`, `src/db/queries.ts` | PostgreSQL pool with retry + all SQL queries |
| 5 | `src/cache/redisClient.ts`, `src/cache/cacheService.ts` | Redis client + cache service |
| 6 | `src/normalization/pipeline.ts`, `src/normalization/accentRemover.ts`, `src/normalization/spellCorrector.ts`, `src/embedding/openaiEmbedding.ts` | Normalization pipeline + embedding |
| 7 | `src/operations/memorySave.ts`, `src/operations/memorySearch.ts`, `src/operations/startupLoad.ts` | Three main operations |
| 8 | `src/health/healthCheck.ts`, `src/index.ts` | Health check + plugin entry point |
| 9 | `v1.openclaw_agent_memory.sql` | SQL migration |
| 10 | `tests/**/*.test.ts` | All test files |

---

## Detailed File Descriptions

### Config Files (Step 1)

---

#### `tsconfig.json`

**Purpose**: TypeScript compiler configuration for the plugin.

**What it does**:
- Targets ES2023 (modern Node.js 22+ features: top-level await, Array.at, etc.)
- Uses Node16 module resolution (supports ESM + CJS interop)
- Enables strict mode for maximum type safety
- Emits declaration files (`.d.ts`) for consumers of the plugin
- Enables `resolveJsonModule` so `src/index.ts` can import `package.json` to read the version string
- Output goes to `dist/`, source lives in `src/`

**Codeflow**: Not applicable (static config).

---

#### `jest.config.ts`

**Purpose**: Test runner configuration.

**What it does**:
- Uses `ts-jest` preset to run TypeScript tests without a separate build step
- Test roots point to `tests/` directory
- Configures module name mapping if needed (e.g., path aliases)
- Sets coverage thresholds (70% minimum for branches, functions, lines)

**Codeflow**: Not applicable (static config).

---

#### `.eslintrc.json`

**Purpose**: Linting rules for code quality and async safety.

**What it does**:
- Extends `@typescript-eslint/recommended`
- Enforces `@typescript-eslint/no-floating-promises` — critical rule that catches un-awaited promises. Without this, a forgotten `await` on a PG query silently drops errors.
- Enforces `@typescript-eslint/no-misused-promises` — prevents passing async functions where sync callbacks are expected

**Codeflow**: Not applicable (static config).

---

#### `.env.example`

**Purpose**: Documented environment variable template. Safe to commit (no real secrets).

**What it does**:
- Lists all 6 env vars with placeholder values and descriptive comments
- Developers copy this to `.env` and fill in real values
- `.env` is in `.gitignore`; `.env.example` is tracked

**Codeflow**: Not applicable (static template).

---

### Core Infrastructure Layer (Step 3)

---

#### `src/config/env.ts`

**Purpose**: Load, validate, and freeze all environment variables at startup. Fail-fast if misconfigured.

**What it does**:
- Calls `dotenv.config()` to load `.env` file (dev only; in K8s, env vars come from Secrets/ConfigMaps)
- Defines a Zod schema with all 6 env vars:
  - `DATABASE_URL` (required, string, must start with `postgresql://` or `postgres://`)
  - `REDIS_URL` (required, string)
  - `OPENAI_API_KEY` (required, string, must start with `sk-`)
  - `TENANCY_NAME` (optional, defaults to `"COMPANY"`)
  - `DB_TABLE_NAME` (optional, defaults to `"v1.openclaw_agent_memory"`)
  - `REDIS_KEY_PREFIX` (optional, defaults to `"openclaw:memory"`)
- Parses `process.env` through the Zod schema
- On validation failure: throws `ConfigError` with a clear message listing which vars are missing/invalid
- On success: exports a frozen `Config` object (read-only singleton)

**Codeflow**:
```
1. dotenv.config()
2. zod.safeParse(process.env)
3. if (!result.success) → throw ConfigError with formatted issues
4. return Object.freeze(result.data) as Config
```

---

#### `src/types/index.ts`

**Purpose**: Shared TypeScript interfaces and type definitions used across all modules.

**What it does**:
- Defines `MemoryType` enum: `'long_term' | 'daily_note' | 'session'`
- Defines `MemoryRow` interface: matches the DB table columns (id, tenant_id, memory_type, content_text, embedding, memory_date, status, created_date, updated_date)
- Defines `MemoryResult` interface: returned from `memory_search` (content_text, similarity score, memory_type, memory_date)
- Defines `MemoryContext` interface: returned from `startup_load` (longTerm content, dailyNotes array, loaded-from indicator)
- Defines `HealthResponse` interface: `{ plugin, version, tenancy, status, postgresql, redis }`
- Defines operation parameter interfaces: `SaveParams`, `SearchParams`, `StartupParams`

**Codeflow**: Not applicable (type definitions only, no runtime code).

---

#### `src/utils/logger.ts`

**Purpose**: Structured logger that prefixes every message with plugin identity.

**What it does**:
- Reads `version` from `package.json` (via `resolveJsonModule`)
- Reads `TENANCY_NAME` from the config
- Constructs prefix: `[memory-pgvector-redis@{version}][{TENANCY_NAME}]`
- Exports `logger` object with methods: `info()`, `warn()`, `error()`, `debug()`
- Each method prepends the prefix + ISO timestamp to the message
- `error()` also logs the stack trace if an `Error` object is provided
- No external logging library — thin wrapper around `console.log/warn/error` for zero dependencies

**Codeflow**:
```
1. Import version from package.json
2. Import TENANCY_NAME from config
3. Build prefix = `[memory-pgvector-redis@${version}][${tenancyName}]`
4. logger.info(msg)  → console.log(`${timestamp} ${prefix} ${msg}`)
5. logger.error(msg, err?) → console.error(`${timestamp} ${prefix} ${msg}`, err?.stack)
```

---

#### `src/errors/pluginErrors.ts`

**Purpose**: Custom error classes and error-handling utilities. Provides structured error context for debugging.

**What it does**:
- Defines 5 custom error classes, all extending `Error`:
  - `ConfigError` — invalid env var, missing config
  - `DatabaseError` — PostgreSQL query/connection failure (includes `code`, `query`, `tenantId`)
  - `CacheError` — Redis operation failure (includes `operation`, `key`)
  - `EmbeddingError` — OpenAI API failure (includes `statusCode`, `retryable`)
  - `NormalizationError` — normalization pipeline failure (includes `step`, `input`)
- Each error class wraps the original error as `cause` (standard ES2022 `Error.cause`)
- Exports helper function `isTransientPgError(err)`: checks error code against known transient codes (`ECONNREFUSED`, `ECONNRESET`, `57P01`, `57P03`, `08006`, `08001`, `08004`)
- Exports `withRetry<T>(fn, opts)`: generic retry wrapper with configurable max attempts, delay, and backoff multiplier
- Exports `withErrorHandling<T>(operation, fn)`: higher-order function that catches errors, wraps them in the appropriate custom class, logs via `logger.error()`, and re-throws or swallows based on severity

**Codeflow**:
```
withRetry(fn, { maxAttempts: 3, delayMs: 500, backoff: 2 }):
  1. attempt = 0
  2. while (attempt < maxAttempts):
     a. try { return await fn() }
     b. catch (err):
        - attempt++
        - if (attempt >= maxAttempts) → throw err
        - await sleep(delayMs * backoff^attempt)

isTransientPgError(err):
  1. Check err.code against TRANSIENT_PG_CODES set
  2. Check err.message for 'ECONNREFUSED', 'ECONNRESET'
  3. Return true if match, false otherwise
```

---

### PostgreSQL Layer (Step 4)

---

#### `src/db/pool.ts`

**Purpose**: PostgreSQL connection pool wrapper with automatic reconnection on connection loss, per-query retry for transient errors, and health probe support.

**What it does**:
- Creates a `pg.Pool` instance with configuration:
  - `connectionString`: from `DATABASE_URL`
  - `max: 10` — max pool size
  - `idleTimeoutMillis: 30_000` — close idle connections after 30s
  - `connectionTimeoutMillis: 5_000` — fail connection attempt after 5s
  - `ssl: { rejectUnauthorized: false }` — required for managed PG (DigitalOcean) with `sslmode=require`
- Registers `pgvector` type extension on the pool (so `vector(1536)` columns are properly handled)
- Maintains internal state: `connected: boolean`, `reconnecting: Promise | null`
- **Pool-level error handler** (`pool.on('error')`):
  - Classifies the error via `isTransientPgError()`
  - If transient: triggers `reconnectLoop()` — exponential backoff `[1s, 2s, 4s, 8s, 16s, 30s(cap)]`, max 10 attempts
  - Each reconnect attempt: creates a new client from pool → runs `SELECT 1` → on success, sets `connected = true`
  - If all 10 attempts fail: logs fatal, sets `connected = false`, health check returns unhealthy
- **`query(text, params)` method** — the primary interface for all SQL execution:
  - If `connected === false` and `reconnecting` exists, awaits reconnect before proceeding
  - Wraps the actual `pool.query(text, params)` call in `withRetry()`:
    - Max 2 retries, 500ms delay, only for transient errors
    - Non-transient errors (syntax, constraint violation) propagate immediately as `DatabaseError`
  - On success: returns `QueryResult`
  - On failure after retries: throws `DatabaseError` with context (query text, params, original error)
- **`healthCheck()` method**: runs `SELECT 1` with a 3-second timeout, returns `boolean`
- **`shutdown()` method**: calls `pool.end()` — waits for in-flight queries, then closes all connections
- **`getPool()` method**: returns the raw pool for transaction support (used in `queries.ts`)

**Codeflow**:
```
INITIALIZATION:
  1. new pg.Pool({ connectionString, max: 10, ... })
  2. pgvector.registerType(pool)
  3. pool.on('error', handlePoolError)
  4. connected = true

handlePoolError(err):
  1. logger.error('Pool error', err)
  2. if (!isTransientPgError(err)) → return (non-transient, nothing to reconnect)
  3. if (reconnecting) → return (already reconnecting)
  4. connected = false
  5. reconnecting = reconnectLoop()

reconnectLoop():
  1. for attempt = 1..10:
     a. delay = min(1000 * 2^(attempt-1), 30000)
     b. await sleep(delay)
     c. try:
        - client = await pool.connect()
        - await client.query('SELECT 1')
        - client.release()
        - connected = true
        - logger.info('Reconnected on attempt ${attempt}')
        - return
     d. catch: logger.warn('Reconnect attempt ${attempt} failed')
  2. logger.error('FATAL: Could not reconnect after 10 attempts')
  3. reconnecting = null

query(text, params):
  1. if (!connected && reconnecting) → await reconnecting
  2. return withRetry(() => pool.query(text, params), {
       maxAttempts: 3,
       delayMs: 500,
       retryIf: isTransientPgError
     })
  3. On final failure: throw new DatabaseError(text, params, err)

healthCheck():
  1. try: await pool.query('SELECT 1') with 3s timeout
  2. return true
  3. catch: return false

shutdown():
  1. await pool.end()
  2. connected = false
  3. logger.info('PostgreSQL pool closed')
```

---

#### `src/db/queries.ts`

**Purpose**: All parameterized SQL queries as named functions. Centralizes SQL in one file — no SQL strings scattered across operations.

**What it does**:
- Imports the `query()` function from `pool.ts` and the `DB_TABLE_NAME` from config
- Dynamically constructs SQL using the configurable table name (safe — it's from env var, not user input)
- Every query includes `WHERE tenant_id = $N` — enforced structurally

**Exported functions**:

1. **`upsertMemory(row: MemoryRow)`**:
   - `INSERT INTO {table} (id, tenant_id, memory_type, content_text, embedding, memory_date, status, created_date, updated_date) VALUES ($1, ...) ON CONFLICT (id, tenant_id) DO UPDATE SET content_text = EXCLUDED.content_text, embedding = EXCLUDED.embedding, updated_date = NOW()`
   - Returns the upserted row

2. **`searchByVector(embedding: number[], tenantId: string, limit: number)`**:
   - Opens a transaction (for `SET LOCAL` scope)
   - `SET LOCAL hnsw.ef_search = 40`
   - `SELECT id, content_text, memory_type, memory_date, 1 - (embedding <=> $1::vector) AS similarity FROM {table} WHERE tenant_id = $2 AND status = 1 ORDER BY embedding <=> $1::vector LIMIT $3`
   - Commits transaction, returns results

3. **`loadLongTerm(tenantId: string)`**:
   - `SELECT content_text, updated_date FROM {table} WHERE tenant_id = $1 AND memory_type = 'long_term' AND status = 1 ORDER BY updated_date DESC LIMIT 1`

4. **`loadRecentDailyNotes(tenantId: string, sinceDate: string)`**:
   - `SELECT content_text, memory_date FROM {table} WHERE tenant_id = $1 AND memory_type = 'daily_note' AND memory_date >= $2 AND status = 1 ORDER BY memory_date DESC`

5. **`updateEmbedding(id: string, tenantId: string, embedding: number[])`**:
   - `UPDATE {table} SET embedding = $3::vector, updated_date = NOW() WHERE id = $1 AND tenant_id = $2`

**Codeflow** (example for `searchByVector`):
```
searchByVector(embedding, tenantId, limit = 5):
  1. client = await pool.connect()
  2. try:
     a. await client.query('BEGIN')
     b. await client.query('SET LOCAL hnsw.ef_search = 40')
     c. result = await client.query(SEARCH_SQL, [embedding, tenantId, limit])
     d. await client.query('COMMIT')
     e. return result.rows as MemoryResult[]
  3. catch:
     a. await client.query('ROLLBACK')
     b. throw new DatabaseError('searchByVector', err)
  4. finally:
     a. client.release()
```

---

### Redis Layer (Step 5)

---

#### `src/cache/redisClient.ts`

**Purpose**: Redis client wrapper with automatic reconnection strategy and health probe.

**What it does**:
- Creates an `ioredis` client instance with configuration:
  - `REDIS_URL` from config
  - `retryStrategy(times)`: returns `Math.min(times * 500, 30_000)` — 500ms, 1s, 1.5s, ..., capped at 30s. Returns `null` after 20 attempts (stops retrying).
  - `lazyConnect: true` — don't connect until first use or explicit `.connect()`
  - `enableReadyCheck: true` — verify connection is actually usable
  - `maxRetriesPerRequest: 3` — per-command retry
  - `enableOfflineQueue: true` — buffer commands while reconnecting
- Listens to events and logs via `logger`:
  - `'connect'` → `logger.info('Redis connected')`
  - `'ready'` → `logger.info('Redis ready')`
  - `'error'` → `logger.error('Redis error', err)`
  - `'close'` → `logger.warn('Redis connection closed')`
  - `'reconnecting'` → `logger.info('Redis reconnecting...')`
- Exports `connect()`: calls `redis.connect()`, wrapped in try/catch
- Exports `healthCheck()`: runs `redis.ping()` with 2s timeout, returns `boolean`
- Exports `shutdown()`: calls `redis.quit()` (graceful) then `redis.disconnect()` (force if needed)
- Exports `getClient()`: returns the raw ioredis instance for `cacheService.ts`

**Codeflow**:
```
INITIALIZATION:
  1. new Redis(REDIS_URL, { retryStrategy, lazyConnect: true, ... })
  2. Register event listeners (connect, ready, error, close, reconnecting)

connect():
  1. try: await redis.connect()
  2. logger.info('Redis connected')
  3. catch: logger.error('Redis initial connection failed', err) — NOT fatal, retryStrategy will handle

healthCheck():
  1. try: result = await redis.ping() (with 2s timeout)
  2. return result === 'PONG'
  3. catch: return false

shutdown():
  1. try: await redis.quit()
  2. catch: redis.disconnect()
  3. logger.info('Redis disconnected')
```

---

#### `src/cache/cacheService.ts`

**Purpose**: High-level Redis cache operations with structured key patterns and TTLs. Implements fail-open pattern — Redis errors never crash the plugin.

**What it does**:
- Imports the Redis client from `redisClient.ts` and `REDIS_KEY_PREFIX` from config
- **Key building**: `buildKey(tenantId, ...segments)` → `{REDIS_KEY_PREFIX}:{tenantId}:{segments.join(':')}`
- **TTL constants**: `SEARCH_TTL = 300` (5m), `DAILY_TTL = 86400` (24h), `SESSION_TTL = 3600` (1h)
- **Every public method is wrapped in try/catch**: on error → `logger.warn()` → return `null`/`undefined`. Never throws.

**Exported functions**:

1. **`getSearchCache(tenantId, hash)`**: GET `{prefix}:{tid}:search:{hash}` → parse JSON → return `MemoryResult[]` or `null`
2. **`setSearchCache(tenantId, hash, results)`**: SET `{prefix}:{tid}:search:{hash}` → JSON.stringify(results) → EX 300
3. **`getLongTerm(tenantId)`**: GET `{prefix}:{tid}:long_term` → return string or `null`
4. **`setLongTerm(tenantId, content)`**: SET `{prefix}:{tid}:long_term` → no TTL (persistent)
5. **`getDaily(tenantId, date)`**: GET `{prefix}:{tid}:daily:{date}` → return string or `null`
6. **`setDaily(tenantId, date, content)`**: SET `{prefix}:{tid}:daily:{date}` → EX 86400
7. **`getSession(tenantId, sessionId)`**: GET `{prefix}:{tid}:session:{sid}` → return string or `null`
8. **`setSession(tenantId, sessionId, content)`**: SET `{prefix}:{tid}:session:{sid}` → EX 3600
9. **`evictSearchCache(tenantId, exceptHash?)`**: SCAN for `{prefix}:{tid}:search:*` → DEL all except `exceptHash`. Uses `SCAN` (not `KEYS *`) to avoid blocking Redis.

**Codeflow** (example for `getSearchCache`):
```
getSearchCache(tenantId, hash):
  1. key = buildKey(tenantId, 'search', hash)
  2. try:
     a. raw = await redis.get(key)
     b. if (!raw) return null
     c. return JSON.parse(raw) as MemoryResult[]
  3. catch (err):
     a. logger.warn(`Redis GET failed for ${key}`, err)
     b. return null   ← fail-open: caller treats as cache miss
```

**Codeflow** (for `evictSearchCache`):
```
evictSearchCache(tenantId, exceptHash?):
  1. pattern = buildKey(tenantId, 'search', '*')
  2. cursor = '0'
  3. do:
     a. [cursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
     b. keysToDelete = exceptHash ? keys.filter(k => !k.endsWith(exceptHash)) : keys
     c. if (keysToDelete.length > 0) await redis.del(...keysToDelete)
  4. while (cursor !== '0')
  5. catch: logger.warn('Search cache eviction failed')  ← fail-open
```

---

### Normalization & Embedding Layer (Step 6)

---

#### `src/normalization/accentRemover.ts`

**Purpose**: Remove Vietnamese (and other) diacritics from text using Unicode decomposition.

**What it does**:
- Exports `removeAccents(text: string): string`
- Uses Unicode NFD (Canonical Decomposition) to split characters into base + combining marks
- Strips all combining diacritical marks (Unicode range `\u0300`–`\u036f`)
- Example: `"Thần Nông"` → NFD → `"Thần Nông"` (decomposed) → strip marks → `"Than Nong"`

**Codeflow**:
```
removeAccents(text):
  1. return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
```

---

#### `src/normalization/spellCorrector.ts`

**Purpose**: Dual-language spell correction using local Hunspell dictionaries. No API calls, no AI, runs in-process.

**What it does**:
- At module load time (once at startup):
  - Loads English dictionary via `nspell` + `dictionary-en` npm package
  - Loads Vietnamese dictionary via `nspell` + bundled `vi_VN.aff` + `vi_VN.dic` files
  - Optionally loads custom dictionary terms from `src/dictionaries/custom.txt` (e.g., `pgvector`, `openclaw`)
  - Adds custom terms to both spell checkers via `.add(word)`
- Exports `spellCorrect(text: string): string` — splits text on whitespace, corrects each word, joins back
- Exports `isLoaded(): boolean` — for health check / startup verification

**Per-word correction logic**:
1. Skip words with length < 2 (articles, single chars)
2. Skip words that are all digits
3. Check if word is valid in **Vietnamese** dictionary → if yes, keep as-is
4. Check if word is valid in **English** dictionary → if yes, keep as-is
5. If invalid in both → get suggestions from **English** first
6. If English has a single clear suggestion (first suggestion) → use it
7. Otherwise get suggestions from **Vietnamese**
8. If Vietnamese has a suggestion → use it
9. If no clear suggestion from either → keep original word (don't guess)

**Codeflow**:
```
STARTUP:
  1. enDict = await loadDictionary('dictionary-en')
  2. enSpell = nspell(enDict)
  3. viAff = readFileSync('src/dictionaries/vi_VN/vi_VN.aff')
  4. viDic = readFileSync('src/dictionaries/vi_VN/vi_VN.dic')
  5. viSpell = nspell(viAff, viDic)
  6. customWords = readFileSync('src/dictionaries/custom.txt').split('\n')
  7. customWords.forEach(w => { enSpell.add(w); viSpell.add(w) })

spellCorrect(text):
  1. words = text.split(/\s+/)
  2. corrected = words.map(word => {
       if (word.length < 2 || /^\d+$/.test(word)) return word
       if (viSpell.correct(word)) return word       // valid Vietnamese
       if (enSpell.correct(word)) return word       // valid English
       const enSuggestions = enSpell.suggest(word)
       if (enSuggestions.length > 0) return enSuggestions[0]
       const viSuggestions = viSpell.suggest(word)
       if (viSuggestions.length > 0) return viSuggestions[0]
       return word                                   // keep original
     })
  3. return corrected.join(' ')
```

---

#### `src/normalization/pipeline.ts`

**Purpose**: The 7-step query normalization pipeline. Produces deterministic cache keys from varied user input.

**What it does**:
- Imports `removeAccents` from `accentRemover.ts`
- Imports `spellCorrect` from `spellCorrector.ts`
- Imports Node.js `crypto` for SHA-256 hashing
- Exports `normalize(input: string): string` — runs steps 1–6, returns normalized string
- Exports `normalizeAndHash(input: string): string` — runs all 7 steps, returns SHA-256 hex hash

**The 7 steps**:
1. **Strip punctuation**: remove `.?!,;:'"()[]{}` characters
2. **Trim**: remove leading/trailing whitespace
3. **Lowercase**: convert all characters to lowercase
4. **Remove accents**: call `removeAccents()` — strips Vietnamese diacritics
5. **Spell correction**: call `spellCorrect()` — fix typos per-word
6. **Collapse whitespace**: replace `/ +/g` with single space
7. **SHA-256 hash**: `crypto.createHash('sha256').update(normalized).digest('hex')`

**Codeflow**:
```
normalize(input):
  1. result = input.replace(/[.?!,;:'"()\[\]{}]/g, '')    // strip punctuation
  2. result = result.trim()                                  // trim
  3. result = result.toLowerCase()                           // lowercase
  4. result = removeAccents(result)                          // remove diacritics
  5. result = spellCorrect(result)                           // fix typos
  6. result = result.replace(/\s+/g, ' ').trim()             // collapse whitespace
  7. return result

normalizeAndHash(input):
  1. normalized = normalize(input)
  2. hash = crypto.createHash('sha256').update(normalized).digest('hex')
  3. return hash
```

**Example**:
```
Input:  " Wht is   Thần Nông AI platform ?"
Step 1: " Wht is   Thần Nông AI platform "
Step 2: "Wht is   Thần Nông AI platform"
Step 3: "wht is   thần nông ai platform"
Step 4: "wht is   than nong ai platform"
Step 5: "what is   than nong ai platform"     ← "wht" → "what"
Step 6: "what is than nong ai platform"
Step 7: SHA-256("what is than nong ai platform") = "b7e9f2a1..."
```

---

#### `src/embedding/openaiEmbedding.ts`

**Purpose**: Generate text embeddings via OpenAI API with retry for transient HTTP errors.

**What it does**:
- Initializes OpenAI client with `OPENAI_API_KEY` from config
- Exports `generateEmbedding(text: string): Promise<number[]>` — generates a 1536-dimension vector
- Uses `text-embedding-3-small` model
- Wraps the API call in retry logic: 2 attempts with 1s delay for HTTP 429 (rate limit), 500, 502, 503
- On permanent failure: logs `EmbeddingError`, returns empty array `[]`
- Caller handles empty array gracefully (memory is saved without embedding)

**Codeflow**:
```
generateEmbedding(text):
  1. try:
     return await withRetry(async () => {
       a. response = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: text
          })
       b. return response.data[0].embedding  // number[1536]
     }, { maxAttempts: 2, delayMs: 1000, retryIf: isRetryableHttpError })
  2. catch (err):
     a. logger.error('Embedding generation failed', err)
     b. return []   ← caller handles gracefully
```

---

### Main Operations (Step 7)

---

#### `src/operations/memorySave.ts`

**Purpose**: Implements the `memory_save(content, memory_type, tenant_id)` operation — the full 6-step write path.

**What it does**:
- This is the **write path** — every memory written by the bot flows through here
- Steps 1–5 are synchronous (awaited in sequence)
- Step 6 (embedding) is **fire-and-forget** — launched asynchronously, not awaited
- If PostgreSQL fails (step 1) → the entire operation fails (throws `DatabaseError`)
- If Redis fails (steps 3–5) → logged as warning, operation continues (data is safe in PG)
- If normalization fails (step 2) → logged, skip cache pre-warm (steps 4–5)
- If embedding generation fails (step 6) → logged, memory exists without vector (searchable by exact match only)

**Codeflow**:
```
memorySave(content, memoryType, tenantId, memoryDate?):
  1. GENERATE ID
     id = uuid.v4()

  2. PG UPSERT (sync — source of truth) ← HARD FAIL if this fails
     try:
       row = { id, tenantId, memoryType, contentText: content, memoryDate, status: 1 }
       await queries.upsertMemory(row)
     catch:
       throw new DatabaseError('memory_save PG UPSERT failed', err)

  3. NORMALIZE CONTENT (for cache pre-warm)
     try:
       normalizedHash = normalizeAndHash(content)
     catch:
       logger.warn('Normalization failed, skipping cache pre-warm')
       normalizedHash = null

  4. REDIS SET memory-type cache (sync — update hot cache)
     try:
       if (memoryType === 'long_term')
         await cacheService.setLongTerm(tenantId, content)
       else if (memoryType === 'daily_note')
         await cacheService.setDaily(tenantId, memoryDate, content)
       else if (memoryType === 'session')
         await cacheService.setSession(tenantId, sessionId, content)
     catch: logger.warn('Redis SET failed')  ← fail-open

  5. REDIS SET search cache pre-warm + EVICT stale (sync)
     try:
       if (normalizedHash) {
         await cacheService.setSearchCache(tenantId, normalizedHash, [{ content_text: content, similarity: 1.0 }])
         await cacheService.evictSearchCache(tenantId, normalizedHash)  // evict all EXCEPT the one just written
       }
     catch: logger.warn('Redis search cache update failed')  ← fail-open

  6. ASYNC: generate embedding → store in same row (fire-and-forget)
     void generateAndStoreEmbedding(id, tenantId, content).catch(err =>
       logger.error('Async embedding failed', err)
     )

  7. RETURN success
     return { id, tenantId, memoryType, status: 'saved' }

--- Helper (not exported) ---
generateAndStoreEmbedding(id, tenantId, content):
  1. embedding = await generateEmbedding(content)
  2. if (embedding.length === 0) return  // generation failed, already logged
  3. await queries.updateEmbedding(id, tenantId, embedding)
  4. logger.info(`Embedding stored for ${id}`)
```

---

#### `src/operations/memorySearch.ts`

**Purpose**: Implements the `memory_search(query, tenant_id)` operation — semantic search with Redis caching.

**What it does**:
- This is the **read path** — every memory search by the bot flows through here
- Step 1: Normalize query → SHA-256 hash (for cache key)
- Step 2: Check Redis cache → if HIT, return immediately (~1ms)
- Step 3: On MISS, generate embedding for the query
- Step 4: pgvector HNSW similarity search on PostgreSQL
- Step 5: Cache results in Redis (TTL 5m)
- Step 6: Return top-K results

**Error handling**:
- Redis failure at step 2 → proceed to step 3 (skip cache)
- Embedding failure at step 3 → return empty results with warning
- PostgreSQL failure at step 4 → throw `DatabaseError`
- Redis failure at step 5 → ignore (results still returned to caller)

**Codeflow**:
```
memorySearch(query, tenantId, limit = 5):
  1. NORMALIZE QUERY
     try:
       normalizedHash = normalizeAndHash(query)
     catch:
       normalizedHash = crypto.createHash('sha256').update(query).digest('hex')
       logger.warn('Normalization failed, using raw hash')

  2. CHECK REDIS CACHE
     cached = await cacheService.getSearchCache(tenantId, normalizedHash)
     if (cached) {
       logger.debug('Search cache HIT')
       return cached   ← fast path (~1ms)
     }

  3. GENERATE QUERY EMBEDDING
     embedding = await generateEmbedding(query)
     if (embedding.length === 0) {
       logger.warn('Query embedding failed, returning empty results')
       return []
     }

  4. PGVECTOR HNSW SEARCH
     results = await queries.searchByVector(embedding, tenantId, limit)

  5. CACHE RESULTS IN REDIS (fire-and-forget)
     void cacheService.setSearchCache(tenantId, normalizedHash, results)

  6. RETURN RESULTS
     return results
```

---

#### `src/operations/startupLoad.ts`

**Purpose**: Implements the `startup_load(tenant_id)` operation — loads memory context when a new chat session starts.

**What it does**:
- Called once per new chat session to warm the bot's context
- Tries Redis first (fast path ~1ms) → falls back to PostgreSQL on miss → warms Redis for subsequent access
- **Never throws** — if both Redis and PG fail, returns empty context and logs error
- Returns a `MemoryContext` object containing long-term memory + recent daily notes

**Codeflow**:
```
startupLoad(tenantId):
  1. LOAD LONG-TERM MEMORY
     try:
       longTerm = await cacheService.getLongTerm(tenantId)
       if (longTerm) {
         source = 'redis'
       } else {
         // Cache miss → fall back to PG
         row = await queries.loadLongTerm(tenantId)
         longTerm = row?.content_text ?? null
         source = 'postgresql'
         // Warm Redis cache
         if (longTerm) void cacheService.setLongTerm(tenantId, longTerm)
       }
     catch:
       logger.error('Failed to load long-term memory')
       longTerm = null

  2. LOAD RECENT DAILY NOTES (today + yesterday)
     try:
       today = new Date().toISOString().slice(0, 10)         // 'YYYY-MM-DD'
       yesterday = /* today minus 1 day */

       // Try Redis for today
       todayNote = await cacheService.getDaily(tenantId, today)
       yesterdayNote = await cacheService.getDaily(tenantId, yesterday)

       if (!todayNote || !yesterdayNote) {
         // Partial or full miss → load from PG
         pgNotes = await queries.loadRecentDailyNotes(tenantId, yesterday)
         dailyNotes = pgNotes.map(r => ({ date: r.memory_date, content: r.content_text }))
         // Warm Redis
         for (const note of dailyNotes) {
           void cacheService.setDaily(tenantId, note.date, note.content)
         }
       } else {
         dailyNotes = [
           { date: today, content: todayNote },
           { date: yesterday, content: yesterdayNote }
         ].filter(n => n.content)
       }
     catch:
       logger.error('Failed to load daily notes')
       dailyNotes = []

  3. BUILD AND RETURN CONTEXT
     return {
       longTerm: longTerm,
       dailyNotes: dailyNotes,
       loadedFrom: source,
       loadedAt: new Date().toISOString()
     } as MemoryContext
```

---

### Health Check & Entry Point (Step 8)

---

#### `src/health/healthCheck.ts`

**Purpose**: Health check handler that probes PostgreSQL and Redis connectivity.

**What it does**:
- Exports `getHealthStatus(): Promise<HealthResponse>`
- Pings PostgreSQL via `pool.healthCheck()` and Redis via `redisClient.healthCheck()`
- Runs both health checks in parallel (`Promise.all`)
- Overall status is `"healthy"` only if **both** are connected
- If only one is connected, status is `"degraded"`
- If neither is connected, status is `"unhealthy"`
- Returns the full `HealthResponse` object (consumed by HTTP handler or OpenClaw framework)

**Codeflow**:
```
getHealthStatus():
  1. [pgOk, redisOk] = await Promise.all([
       pool.healthCheck(),
       redisClient.healthCheck()
     ])
  2. status = (pgOk && redisOk) ? 'healthy'
            : (pgOk || redisOk) ? 'degraded'
            : 'unhealthy'
  3. return {
       plugin: 'memory-pgvector-redis',
       version: version,       // from package.json
       tenancy: TENANCY_NAME,  // from config
       status: status,
       postgresql: pgOk ? 'connected' : 'disconnected',
       redis: redisOk ? 'connected' : 'disconnected'
     }
```

---

#### `src/index.ts`

**Purpose**: Plugin entry point. Initializes all subsystems and exports the public API.

**What it does**:
- This is the file that OpenClaw loads when activating the `memory-pgvector-redis` plugin
- On import/initialization:
  1. Loads and validates config (`env.ts`)
  2. Initializes PostgreSQL pool (`pool.ts`)
  3. Connects to Redis (`redisClient.ts`)
  4. Loads Hunspell dictionaries (`spellCorrector.ts`)
  5. Logs startup banner
- Exports the public API: `{ memorySave, memorySearch, startupLoad, healthCheck, shutdown }`
- Registers `SIGTERM` / `SIGINT` handlers for graceful shutdown

**Codeflow**:
```
INITIALIZATION (runs once on plugin load):
  1. config = loadConfig()                         // fail-fast if env vars invalid
  2. await initPool(config.DATABASE_URL)           // create PG pool + register pgvector
  3. await connectRedis(config.REDIS_URL)          // connect ioredis
  4. await loadDictionaries()                      // load en_US + vi_VN Hunspell
  5. logger.info(`memory-pgvector-redis@${version} initialized — tenancy=${config.TENANCY_NAME}, table=${config.DB_TABLE_NAME}`)

GRACEFUL SHUTDOWN:
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  async shutdown():
    1. logger.info('Shutting down...')
    2. await pool.shutdown()
    3. await redisClient.shutdown()
    4. logger.info('Shutdown complete')
    5. process.exit(0)

EXPORTS:
  export { memorySave }      from './operations/memorySave'
  export { memorySearch }    from './operations/memorySearch'
  export { startupLoad }     from './operations/startupLoad'
  export { getHealthStatus } from './health/healthCheck'
  export { shutdown }
```

---

### SQL Migration (Step 9)

---

#### `src/main/resources/db/migration/dev/v1.openclaw_agent_memory.sql`

**Purpose**: Full DDL script to create the memory table with 8 hash partitions and 32 indexes.

**What it does**:
1. `CREATE EXTENSION IF NOT EXISTS vector` — enable pgvector
2. `CREATE SCHEMA IF NOT EXISTS v1` — ensure schema exists
3. Create parent table `v1.openclaw_agent_memory` with `PARTITION BY HASH (tenant_id)`
4. Create 8 child partitions: `_h0` through `_h7` (each for `MODULUS 8, REMAINDER 0..7`)
5. For each partition, create 4 indexes:
   - B-tree on `(tenant_id, memory_type)` — filter by type
   - B-tree partial on `(tenant_id) WHERE status = 1` — active-only queries
   - B-tree on `(tenant_id, memory_date)` — daily note date lookup
   - HNSW on `embedding vector_cosine_ops` with `m=16, ef_construction=64` — ANN search
6. All statements use `IF NOT EXISTS` for idempotency (safe to re-run)

**Total objects created**: 1 schema + 1 parent table + 8 partitions + 32 indexes = **42 objects**

---

### Tests (Step 10)

---

#### `tests/unit/normalization.test.ts`

**Purpose**: Test all 7 normalization steps individually and end-to-end.

**Test cases**:
- Strip punctuation: `"Hello?"` → `"Hello"`
- Trim: `"  hello  "` → `"hello"`
- Lowercase: `"HELLO"` → `"hello"`
- Remove accents: `"Thần Nông"` → `"Than Nong"`
- Spell correction: `"wht"` → `"what"` (English), `"xin"` → `"xin"` (valid Vietnamese)
- Collapse whitespace: `"hello   world"` → `"hello world"`
- Full pipeline: the 4-input example from README → all produce same hash
- Edge cases: empty string, single character, all punctuation, Unicode emoji

---

#### `tests/unit/cacheService.test.ts`

**Purpose**: Test Redis key building, TTL assignment, and SCAN-based eviction.

**Test cases**:
- `buildKey('T1', 'long_term')` → `"openclaw:memory:T1:long_term"`
- `buildKey('T1', 'search', 'abc123')` → `"openclaw:memory:T1:search:abc123"`
- Custom prefix: `buildKey` with `REDIS_KEY_PREFIX=thannong:company` → correct key
- TTL values: search=300, daily=86400, session=3600, long_term=none
- Fail-open: mock Redis throw → method returns `null` (not throw)

---

#### `tests/unit/pluginErrors.test.ts`

**Purpose**: Test error classification and wrapping.

**Test cases**:
- `isTransientPgError` correctly identifies: `ECONNREFUSED`, `57P01`, `08006` → `true`
- `isTransientPgError` correctly rejects: `23505`, `42P01`, syntax error → `false`
- `DatabaseError` wraps original error with context
- `withRetry` retries on transient, does not retry on non-transient
- `withRetry` respects `maxAttempts`

---

#### `tests/integration/memorySave.test.ts`

**Purpose**: Test the full 6-step write path with mocked PG and Redis.

**Test cases**:
- Happy path: PG upsert + Redis SET + embedding all succeed
- PG failure: throws `DatabaseError`, Redis not called
- Redis failure on step 4: logged as warning, PG data intact, no throw
- Embedding failure on step 6: logged, memory saved without vector
- Normalization failure: logged, skip cache pre-warm, PG data intact

---

#### `tests/integration/memorySearch.test.ts`

**Purpose**: Test cache hit and cache miss → HNSW paths.

**Test cases**:
- Cache HIT: Redis returns results, PG not called, returns fast
- Cache MISS: Redis returns null → embedding generated → PG HNSW search → results cached
- Redis failure: proceeds directly to PG search (no throw)
- Embedding failure: returns empty array with warning
- PG failure on HNSW: throws `DatabaseError`

---

#### `tests/e2e/healthCheck.test.ts`

**Purpose**: Test health check response format.

**Test cases**:
- Both connected: `{ status: "healthy", postgresql: "connected", redis: "connected" }`
- PG down: `{ status: "degraded", postgresql: "disconnected", redis: "connected" }`
- Redis down: `{ status: "degraded", postgresql: "connected", redis: "disconnected" }`
- Both down: `{ status: "unhealthy", postgresql: "disconnected", redis: "disconnected" }`
- Response includes correct `plugin`, `version`, `tenancy` fields

---

## PostgreSQL Pool Retry Strategy

### Pool-Level Reconnection

| Event | Handler | Behavior |
|-------|---------|----------|
| `pool.on('error')` | `handlePoolError()` | Classify error → if transient, start reconnect loop |
| Reconnect attempt | `reconnectLoop()` | Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap), max 10 attempts |
| Reconnect success | Inside loop | Set `connected = true`, log info, resolve promise |
| Reconnect exhausted | After 10 failures | Log fatal, `connected = false`, health returns unhealthy |
| Graceful shutdown | `pool.shutdown()` | `pool.end()` — drain active queries, close connections |

### Per-Query Retry

| Error Type | Codes | Retry? | Max Attempts | Delay |
|-----------|-------|--------|-------------|-------|
| Transient (connection) | `ECONNREFUSED`, `ECONNRESET`, `08006`, `08001`, `08004` | ✅ Yes | 3 (1 + 2 retries) | 500ms |
| Transient (server) | `57P01` (admin shutdown), `57P03` (not accepting) | ✅ Yes | 3 | 500ms |
| Non-transient (client) | `23505` (unique), `42P01` (no table), syntax errors | ❌ No | — | — |

---

## Exception Handling Patterns

| Layer | Pattern | On Failure |
|-------|---------|-----------|
| **Config** (`env.ts`) | `zod.parse()` at startup | ❌ Fail-fast — plugin won't start |
| **PG Pool** (`pool.ts`) | Exponential backoff reconnect | Degraded health. Operations throw `DatabaseError`. |
| **PG Query** (`queries.ts` → `pool.ts`) | Per-query retry (2×, 500ms) | Non-transient → immediate `DatabaseError` |
| **Redis** (`cacheService.ts`) | Every method try/catch → return `null` | ⚠️ Fail-open: log + return null → fall through to PG |
| **Embedding** (`openaiEmbedding.ts`) | HTTP retry (2×, 1s) | ⚠️ Return `[]` → memory saved without vector |
| **Normalization** (`pipeline.ts`) | try/catch → fallback to raw SHA-256 | ⚠️ Cache key may differ, PG search still works |
| **memory_save** | Step-by-step try/catch | PG fail = throw. Redis/embedding = log + continue |
| **memory_search** | Step-by-step try/catch | Redis fail = skip cache. Embedding fail = empty results |
| **startup_load** | Full try/catch | Never throws. Both fail = empty context + log |

**Golden rule**: PostgreSQL failure = hard error (throw). Everything else = soft error (log + continue).

---

## Dependencies

### Runtime

| Package | Version | Purpose |
|---------|---------|---------|
| `pg` | `^8.x` | PostgreSQL client with Pool |
| `pgvector` | `^0.2.x` | Register vector type with pg |
| `ioredis` | `^5.x` | Redis client with reconnect |
| `openai` | `^4.x` | OpenAI SDK for embeddings |
| `nspell` | `^4.x` | Hunspell spell checker |
| `dictionary-en` | `^4.x` | English dictionary for nspell |
| `dotenv` | `^16.x` | Load .env file |
| `zod` | `^3.x` | Env var validation |
| `uuid` | `^11.x` | UUID generation |

### Dev

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | `^5.x` | Compiler |
| `@types/node` | `^22.x` | Node.js typings |
| `@types/pg` | `^8.x` | pg typings |
| `ts-jest` | `^29.x` | Jest TypeScript support |
| `jest` | `^29.x` | Test runner |
| `@types/jest` | `^29.x` | Jest typings |
| `eslint` | `^9.x` | Linter |
| `@typescript-eslint/eslint-plugin` | `^8.x` | TypeScript ESLint rules |
| `@typescript-eslint/parser` | `^8.x` | TypeScript ESLint parser |

---

## Implementation Order

The steps above follow a bottom-up dependency order:

```
Step 1: Config files (tsconfig, jest, eslint, .env.example)
   ↓
Step 2: Install dependencies (package.json update)
   ↓
Step 3: Core infra (config, types, logger, errors)
   ↓ depends on Step 3
Step 4: PG pool + queries    Step 5: Redis client + cache    Step 6: Normalization + embedding
   ↓                            ↓                              ↓
   └────────────────────────────┴──────────────────────────────┘
                                ↓ depends on Steps 4, 5, 6
Step 7: Three main operations (memorySave, memorySearch, startupLoad)
   ↓ depends on Step 7
Step 8: Health check + entry point (index.ts)
   ↓
Step 9: SQL migration (standalone, can be done anytime)
   ↓
Step 10: Tests (after all source files exist)
```

