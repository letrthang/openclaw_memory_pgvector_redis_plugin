// ─── Shared TypeScript types for the memory-pgvector-redis plugin ───

/** Memory type categories */
export type MemoryType = 'long_term' | 'daily_note' | 'session';

/** Embedding provider choices */
export type EmbeddingProviderType = 'anthropic' | 'openai' | 'local';

/** Matches a row in the memory DB table */
export interface MemoryRow {
  id: string;
  tenant_id: string;
  memory_type: MemoryType;
  content_text: string;
  embedding?: number[] | null;
  memory_date?: string | null;
  status: number;
  created_date?: Date;
  updated_date?: Date;
}

/** Returned from memory_search (vector similarity results) */
export interface MemoryResult {
  id: string;
  content_text: string;
  similarity: number;
  memory_type: MemoryType;
  memory_date?: string | null;
}

/** Returned from startup_load */
export interface MemoryContext {
  longTerm: string | null;
  dailyNotes: DailyNote[];
  loadedFrom: 'redis' | 'postgresql';
  loadedAt: string;
}

export interface DailyNote {
  date: string;
  content: string;
}

/** Health check response */
export interface HealthResponse {
  plugin: string;
  version: string;
  tenancy: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  postgresql: 'connected' | 'disconnected';
  redis: 'connected' | 'disconnected';
  embedding: EmbeddingProviderInfo;
}

export interface EmbeddingProviderInfo {
  name: string;
  model: string;
  dimensions: number;
}

/** Operation parameter interfaces */
export interface SaveParams {
  content: string;
  memoryType: MemoryType;
  tenantId: string;
  memoryDate?: string;
  sessionId?: string;
}

export interface SaveResult {
  id: string;
  tenantId: string;
  memoryType: MemoryType;
  status: 'saved';
}

export interface SearchParams {
  query: string;
  tenantId: string;
  limit?: number;
}

export interface StartupParams {
  tenantId: string;
}

/** Retry options */
export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  backoff?: number;
  retryIf?: (err: unknown) => boolean;
}

