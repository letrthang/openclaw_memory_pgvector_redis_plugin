// ─── Remove Vietnamese (and other) diacritics via Unicode decomposition ───

/**
 * Removes all diacritical marks by decomposing to NFD then stripping combining marks.
 * Example: "Thần Nông" → "Than Nong"
 */
export function removeAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

