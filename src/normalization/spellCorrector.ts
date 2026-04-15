// ─── Dual-language spell correction using local Hunspell dictionaries ───

import nspell from 'nspell';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';

let enSpell: ReturnType<typeof nspell> | null = null;
let viSpell: ReturnType<typeof nspell> | null = null;
let loaded = false;

/**
 * Initialize spell checkers. Must be called at startup.
 * Loads English dictionary (from dictionary-en) and Vietnamese dictionary (bundled).
 */
export async function loadDictionaries(): Promise<void> {
  try {
    // Load English dictionary
    // dictionary-en v4+ exports a promise-like default that resolves to { aff, dic }
    const enModule = await import('dictionary-en');
    const enData = await enModule.default;
    enSpell = nspell(enData.aff, enData.dic);

    // Load Vietnamese dictionary (bundled files)
    const viAffPath = resolve(__dirname, '../dictionaries/vi_VN/vi_VN.aff');
    const viDicPath = resolve(__dirname, '../dictionaries/vi_VN/vi_VN.dic');

    if (existsSync(viAffPath) && existsSync(viDicPath)) {
      const viAff = readFileSync(viAffPath);
      const viDic = readFileSync(viDicPath);
      viSpell = nspell(viAff, viDic);
      logger.info('Vietnamese dictionary loaded');
    } else {
      logger.warn('Vietnamese dictionary files not found, skipping vi_VN spell check');
    }

    // Load custom terms if exists
    const customPath = resolve(__dirname, '../dictionaries/custom.txt');
    if (existsSync(customPath)) {
      const customWords = readFileSync(customPath, 'utf-8')
        .split('\n')
        .map((w) => w.trim())
        .filter((w) => w.length > 0);
      for (const word of customWords) {
        enSpell.add(word);
        viSpell?.add(word);
      }
      logger.info(`Custom dictionary loaded (${customWords.length} words)`);
    }

    loaded = true;
    logger.info('Spell checkers initialized (en + vi)');
  } catch (err) {
    logger.error('Failed to load dictionaries', err);
    loaded = false;
  }
}

/**
 * Check if dictionaries are loaded.
 */
export function isLoaded(): boolean {
  return loaded;
}

/**
 * Spell-correct text using dual-language dictionaries.
 * Per-word: Vietnamese → English → suggestion → keep original.
 */
export function spellCorrect(text: string): string {
  if (!loaded || !enSpell) return text;

  const words = text.split(/\s+/);
  const corrected = words.map((word) => {
    // Skip short words, digits
    if (word.length < 2 || /^\d+$/.test(word)) return word;

    // Valid in Vietnamese?
    if (viSpell?.correct(word)) return word;

    // Valid in English?
    if (enSpell!.correct(word)) return word;

    // Get English suggestions
    const enSuggestions = enSpell!.suggest(word);
    if (enSuggestions.length > 0) return enSuggestions[0];

    // Get Vietnamese suggestions
    const viSuggestions = viSpell?.suggest(word);
    if (viSuggestions && viSuggestions.length > 0) return viSuggestions[0];

    // No clear suggestion — keep original
    return word;
  });

  return corrected.join(' ');
}

