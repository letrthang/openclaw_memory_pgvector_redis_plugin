// ─── 7-step query normalization pipeline ───

import crypto from 'crypto';
import { removeAccents } from './accentRemover.js';
import { spellCorrect } from './spellCorrector.js';

/**
 * Run steps 1–6 of the normalization pipeline.
 * Returns a normalized, deterministic string.
 */
export function normalize(input: string): string {
  // Step 1: Strip punctuation
  let result = input.replace(/[.?!,;:'"()\[\]{}]/g, '');

  // Step 2: Trim
  result = result.trim();

  // Step 3: Lowercase
  result = result.toLowerCase();

  // Step 4: Spell correction (BEFORE accent removal — Vietnamese is tonal,
  //         the spell checker needs accented text to work correctly)
  result = spellCorrect(result);

  // Step 5: Remove accents (Vietnamese diacritics — after spell correction)
  result = removeAccents(result);

  // Step 6: Collapse whitespace
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

/**
 * Run all 7 steps: normalize + SHA-256 hash.
 * Returns a hex hash string (cache key).
 */
export function normalizeAndHash(input: string): string {
  const normalized = normalize(input);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

