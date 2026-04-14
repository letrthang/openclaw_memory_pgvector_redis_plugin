// ─── startup_load operation — warm memory context for new chat sessions ───

import * as queries from '../db/queries.js';
import * as cacheService from '../cache/cacheService.js';
import { logger } from '../utils/logger.js';
import type { MemoryContext, DailyNote } from '../types/index.js';

/**
 * Load memory context at chat session startup.
 *
 * Tries Redis first (fast ~1ms) → falls back to PostgreSQL → warms Redis.
 * NEVER throws — returns empty context on total failure.
 */
export async function startupLoad(tenantId: string): Promise<MemoryContext> {
  let longTerm: string | null = null;
  let source: 'redis' | 'postgresql' = 'redis';
  let dailyNotes: DailyNote[] = [];

  // ─── 1. Load Long-Term Memory ───
  try {
    longTerm = await cacheService.getLongTerm(tenantId);
    if (longTerm) {
      source = 'redis';
    } else {
      // Cache miss → fall back to PG
      const row = await queries.loadLongTerm(tenantId);
      longTerm = row?.content_text ?? null;
      source = 'postgresql';

      // Warm Redis cache
      if (longTerm) {
        void cacheService.setLongTerm(tenantId, longTerm).catch((err) =>
          logger.error('Failed to warm long-term cache', err)
        );
      }
    }
  } catch (err) {
    logger.error('Failed to load long-term memory', err);
    longTerm = null;
  }

  // ─── 2. Load Recent Daily Notes (today + yesterday) ───
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = yesterdayDate.toISOString().slice(0, 10);

    // Try Redis for today and yesterday
    const todayNote = await cacheService.getDaily(tenantId, today);
    const yesterdayNote = await cacheService.getDaily(tenantId, yesterday);

    if (!todayNote || !yesterdayNote) {
      // Partial or full miss → load from PG
      const pgNotes = await queries.loadRecentDailyNotes(tenantId, yesterday);
      dailyNotes = pgNotes.map((r) => ({
        date: r.memory_date,
        content: r.content_text,
      }));

      // Warm Redis
      for (const note of dailyNotes) {
        void cacheService.setDaily(tenantId, note.date, note.content).catch((err) =>
          logger.error('Failed to warm daily cache', err)
        );
      }
    } else {
      dailyNotes = [
        { date: today, content: todayNote },
        { date: yesterday, content: yesterdayNote },
      ].filter((n) => n.content);
    }
  } catch (err) {
    logger.error('Failed to load daily notes', err);
    dailyNotes = [];
  }

  // ─── 3. Build and return context ───
  return {
    longTerm,
    dailyNotes,
    loadedFrom: source,
    loadedAt: new Date().toISOString(),
  };
}

