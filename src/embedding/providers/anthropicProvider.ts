// ─── Anthropic embedding provider — uses Voyage AI (Anthropic's recommended embeddings partner) ───

import type { EmbeddingProvider, EmbeddingProviderConfig } from '../embeddingProvider.js';
import { withRetry, isRetryableHttpError, EmbeddingError } from '../../errors/pluginErrors.js';
import { logger } from '../../utils/logger.js';

// Voyage AI model → dimension mapping
const VOYAGE_DIMENSIONS: Record<string, number> = {
  'voyage-3-large': 1024,
  'voyage-3': 1024,
  'voyage-3-lite': 512,
  'voyage-code-3': 1024,
};

/**
 * Embedding provider using Voyage AI (Anthropic's recommended partner for embeddings).
 * Anthropic does not offer a native embeddings API — Voyage AI provides
 * high-quality embeddings optimized for use with Claude.
 *
 * Supported models (via EMBEDDING_MODEL env var):
 *   voyage-3-large (1024d) | voyage-3 (1024d) | voyage-3-lite (512d) | voyage-code-3 (1024d)
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/embeddings
 */
export class AnthropicProvider implements EmbeddingProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(cfg: EmbeddingProviderConfig) {
    this.apiKey = cfg.apiKey;
    this.model = cfg.model || 'voyage-3';
    this.baseUrl = cfg.baseUrl || 'https://api.voyageai.com';
  }

  getDimensions(): number {
    return VOYAGE_DIMENSIONS[this.model] ?? 1024;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      return await withRetry(
        async () => {
          const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model: this.model,
              input: text,
              input_type: 'document',
            }),
          });

          if (!response.ok) {
            const errBody = await response.text().catch(() => 'unknown');
            const err = new EmbeddingError(
              `Voyage AI embeddings API returned ${response.status}: ${errBody}`,
              { provider: this.name, statusCode: response.status, retryable: [429, 500, 502, 503].includes(response.status) }
            );
            // Attach status for retryIf
            (err as unknown as { status: number }).status = response.status;
            throw err;
          }

          const data = (await response.json()) as {
            data: Array<{ embedding: number[] }>;
          };
          return data.data[0].embedding;
        },
        { maxAttempts: 2, delayMs: 1000, retryIf: isRetryableHttpError }
      );
    } catch (err) {
      logger.error(`[${this.name}] Embedding generation failed (model=${this.model})`, err);
      return [];
    }
  }
}

