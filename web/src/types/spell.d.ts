/* Vite raw imports of the Hunspell dictionary files, and a minimal surface
   for nspell, which ships no types. */

declare module '*.aff?raw' {
  const contents: string;
  export default contents;
}

declare module '*.dic?raw' {
  const contents: string;
  export default contents;
}

declare module 'nspell' {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
  }
  function nspell(aff: string, dic: string): NSpell;
  export default nspell;
  export type { NSpell };
}
