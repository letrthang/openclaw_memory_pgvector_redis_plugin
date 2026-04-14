// ─── Embedding service — factory + singleton, single entry point for all embeddings ───

import type { EmbeddingProvider } from './embeddingProvider.js';
import type { EmbeddingProviderInfo } from '../types/index.js';
import { config } from '../config/env.js';
import { ConfigError } from '../errors/pluginErrors.js';
import { logger } from '../utils/logger.js';
import { AnthropicProvider } from './providers/anthropicProvider.js';
import { OpenAIProvider } from './providers/openaiProvider.js';
import { LocalProvider } from './providers/localProvider.js';

let instance: EmbeddingProvider;

/**
 * Initialize the embedding service. Creates the correct provider based on config.
 */
export function initEmbeddingService(): void {
  const providerType = config.EMBEDDING_PROVIDER;
  const providerConfig = {
    provider: providerType,
    apiKey: config.EMBEDDING_API_KEY,
    model: config.EMBEDDING_MODEL,
    baseUrl: config.EMBEDDING_BASE_URL,
  };

  switch (providerType) {
    case 'anthropic':
      instance = new AnthropicProvider(providerConfig);
      break;
    case 'openai':
      instance = new OpenAIProvider(providerConfig);
      break;
    case 'local':
      instance = new LocalProvider(providerConfig);
      break;
    default:
      throw new ConfigError(`Unknown EMBEDDING_PROVIDER: ${providerType}`);
  }

  logger.info(
    `Embedding provider: ${instance.name}, model: ${config.EMBEDDING_MODEL}, dimensions: ${instance.getDimensions()}`
  );
}

/**
 * Get the embedding dimensions from the active provider.
 * Used for startup validation against DB schema.
 */
export function getDimensions(): number {
  if (!instance) return 0;
  return instance.getDimensions();
}

/**
 * Generate an embedding vector from text. Delegates to the active provider.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!instance) {
    throw new ConfigError('Embedding service not initialized. Call initEmbeddingService() first.');
  }
  const result = await instance.generateEmbedding(text);
  if (result.length > 0 && result.length !== instance.getDimensions()) {
    logger.warn(
      `Embedding dimension mismatch: expected ${instance.getDimensions()}, got ${result.length}`
    );
  }
  return result;
}

/**
 * Get info about the active embedding provider (for health check / startup banner).
 */
export function getProviderInfo(): EmbeddingProviderInfo {
  if (!instance) {
    return { name: 'none', model: 'none', dimensions: 0 };
  }
  return {
    name: instance.name,
    model: config.EMBEDDING_MODEL,
    dimensions: instance.getDimensions(),
  };
}

