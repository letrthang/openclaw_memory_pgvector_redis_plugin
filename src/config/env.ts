// ─── Environment configuration with Zod validation ───

import dotenv from 'dotenv';
import { z } from 'zod';
import { ConfigError } from '../errors/pluginErrors.js';

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (url) => url.startsWith('postgresql://') || url.startsWith('postgres://'),
      'DATABASE_URL must start with postgresql:// or postgres://'
    ),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  EMBEDDING_PROVIDER: z
    .enum(['anthropic', 'openai', 'local'])
    .default('anthropic'),
  EMBEDDING_API_KEY: z.string().min(1, 'EMBEDDING_API_KEY is required'),
  EMBEDDING_MODEL: z.string().default('voyage-3'),
  EMBEDDING_BASE_URL: z.string().optional(),
  TENANCY_NAME: z.string().default('COMPANY'),
  DB_TABLE_NAME: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_.]*$/, 'DB_TABLE_NAME must be a valid SQL identifier (letters, digits, underscores, dots)')
    .default('v1.openclaw_agent_memory'),
  REDIS_KEY_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_:.-]+$/, 'REDIS_KEY_PREFIX must be alphanumeric with colons, dots, hyphens, or underscores')
    .default('openclaw:memory'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  MAX_CONTENT_LENGTH: z.coerce.number().int().positive().default(32_000),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }

  return Object.freeze(result.data);
}

/** Validated, frozen config singleton */
export const config: Config = loadConfig();

