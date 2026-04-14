// ─── EmbeddingProvider interface — contract for all embedding providers ───

/**
 * Every embedding provider must implement this interface.
 * Enables provider swapping via config without code changes.
 */
export interface EmbeddingProvider {
  /** Provider identifier (e.g., 'anthropic', 'openai', 'local') */
  readonly name: string;

  /** Generate a single embedding vector from text */
  generateEmbedding(text: string): Promise<number[]>;

  /** Return the embedding dimensions (e.g., 1536) */
  getDimensions(): number;
}

/** Configuration passed to provider constructors */
export interface EmbeddingProviderConfig {
  provider: 'anthropic' | 'openai' | 'local';
  apiKey: string;
  model: string;
  baseUrl?: string;
}

