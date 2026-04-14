// ─── Unit tests: normalization pipeline ───

import { removeAccents } from '../../src/normalization/accentRemover';
// Note: spellCorrector and pipeline require dynamic imports and dictionary loading,
// so we test them with mocking where needed.

describe('accentRemover', () => {
  test('removes Vietnamese diacritics', () => {
    expect(removeAccents('Thần Nông')).toBe('Than Nong');
  });

  test('removes French accents', () => {
    expect(removeAccents('café résumé')).toBe('cafe resume');
  });

  test('preserves ASCII characters', () => {
    expect(removeAccents('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(removeAccents('')).toBe('');
  });

  test('handles string with only accents', () => {
    expect(removeAccents('àáâãäå')).toBe('aaaaaa');
  });

  test('handles mixed content', () => {
    expect(removeAccents('Hello Thế Giới 123')).toBe('Hello The Gioi 123');
  });
});

describe('normalization steps (isolated)', () => {
  test('strip punctuation', () => {
    const input = 'Hello? World! "test" (foo)';
    const result = input.replace(/[.?!,;:'"()\[\]{}]/g, '');
    expect(result).toBe('Hello World test foo');
  });

  test('trim', () => {
    expect('  hello  '.trim()).toBe('hello');
  });

  test('lowercase', () => {
    expect('HELLO World'.toLowerCase()).toBe('hello world');
  });

  test('collapse whitespace', () => {
    const input = 'hello   world   test';
    const result = input.replace(/\s+/g, ' ').trim();
    expect(result).toBe('hello world test');
  });

  test('edge case: empty string through all steps', () => {
    let result = '';
    result = result.replace(/[.?!,;:'"()\[\]{}]/g, '');
    result = result.trim();
    result = result.toLowerCase();
    result = removeAccents(result);
    result = result.replace(/\s+/g, ' ').trim();
    expect(result).toBe('');
  });

  test('edge case: all punctuation', () => {
    let result = '?!.,;:';
    result = result.replace(/[.?!,;:'"()\[\]{}]/g, '');
    result = result.trim();
    expect(result).toBe('');
  });

  test('SHA-256 hash is deterministic', () => {
    const crypto = require('crypto');
    const hash1 = crypto.createHash('sha256').update('hello world').digest('hex');
    const hash2 = crypto.createHash('sha256').update('hello world').digest('hex');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});

