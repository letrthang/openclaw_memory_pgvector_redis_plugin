// ─── Structured logger with plugin identity prefix and LOG_LEVEL support ───

import { config } from '../config/env.js';

// Read version from package.json at build time
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../../package.json');

const prefix = `[memory-pgvector-redis@${version}][${config.TENANCY_NAME}]`;

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const currentLevel = LOG_LEVELS[config.LOG_LEVEL] ?? LOG_LEVELS.info;

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LOG_LEVELS.info) {
      console.log(`${timestamp()} ${prefix} INFO  ${msg}`, ...args);
    }
  },

  warn(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LOG_LEVELS.warn) {
      console.warn(`${timestamp()} ${prefix} WARN  ${msg}`, ...args);
    }
  },

  error(msg: string, err?: unknown): void {
    if (currentLevel <= LOG_LEVELS.error) {
      if (err instanceof Error) {
        console.error(`${timestamp()} ${prefix} ERROR ${msg}`, err.message, err.stack);
      } else {
        console.error(`${timestamp()} ${prefix} ERROR ${msg}`, err);
      }
    }
  },

  debug(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LOG_LEVELS.debug) {
      console.log(`${timestamp()} ${prefix} DEBUG ${msg}`, ...args);
    }
  },
};

