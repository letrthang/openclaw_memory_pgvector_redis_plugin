// ─── OpenAI embedding provider (text-embedding-3-small, text-embedding-3-large) ───

import OpenAI from 'openai';
import type { EmbeddingProvider, EmbeddingProviderConfig } from '../embeddingProvider.js';
import { withRetry, isRetryableHttpError } from '../../errors/pluginErrors.js';
import { logger } from '../../utils/logger.js';

/**
 * Embedding provider using OpenAI models.
 * Serves as fallback/alternative to Anthropic.
 */
export class OpenAIProvider implements EmbeddingProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(cfg: EmbeddingProviderConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey });
    this.model = cfg.model || 'text-embedding-3-small';
  }

  getDimensions(): number {
    return this.model.includes('large') ? 3072 : 1536;
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
        { maxAttempts: 2, delayMs: 1000, retryIf: isRetryableHttpError }
      );
    } catch (err) {
      logger.error(`[${this.name}] Embedding generation failed (model=${this.model})`, err);
      return [];
    }
  }
}

