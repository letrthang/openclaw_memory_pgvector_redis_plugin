// ─── Local embedding provider (OpenAI-compatible API: Ollama, vLLM, LocalAI, llama.cpp) ───

import OpenAI from 'openai';
import type { EmbeddingProvider, EmbeddingProviderConfig } from '../embeddingProvider.js';
import { ConfigError, withRetry, isRetryableHttpError } from '../../errors/pluginErrors.js';
import { logger } from '../../utils/logger.js';

/**
 * Embedding provider for local/self-hosted models with OpenAI-compatible API.
 * Useful for air-gapped environments, cost-zero deployments, or testing.
 */
export class LocalProvider implements EmbeddingProvider {
  readonly name = 'local';
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(cfg: EmbeddingProviderConfig) {
    if (!cfg.baseUrl) {
      throw new ConfigError('EMBEDDING_BASE_URL is required when EMBEDDING_PROVIDER=local');
    }

    this.baseUrl = cfg.baseUrl;
    this.client = new OpenAI({
      apiKey: cfg.apiKey || 'not-needed',
      baseURL: cfg.baseUrl,
    });
    this.model = cfg.model || 'nomic-embed-text';
  }

  getDimensions(): number {
    // Default for nomic-embed-text; varies by model
    return 768;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      return await withRetry(
        async () => {
          const response = await this.client.embeddings.create({
            model: this.model,
            input: text,
          });
          return response.data[0].embedding;
        },
        { maxAttempts: 2, delayMs: 500, retryIf: isRetryableHttpError }
      );
    } catch (err) {
      logger.error(
        `[${this.name}] Embedding generation failed (model=${this.model}, baseUrl=${this.baseUrl})`,
        err
      );
      return [];
    }
  }
}

