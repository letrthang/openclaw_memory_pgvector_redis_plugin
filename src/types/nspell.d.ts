declare module 'nspell' {
  interface Spell {
    correct(word: string): boolean;
    suggest(word: string): string[];
    add(word: string): void;
  }

  function nspell(aff: Buffer | string, dic: Buffer | string): Spell;
  export default nspell;
}

declare module 'dictionary-en' {
  const dictionary: Promise<{ aff: Buffer; dic: Buffer }>;
  export default dictionary;
}

