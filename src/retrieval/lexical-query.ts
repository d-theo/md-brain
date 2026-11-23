const MAX_TERMS = 32;
/** Longer terms also match their inflections (`toxique` -> `toxiques`, `message` -> `messages`). */
const PREFIX_MIN_LENGTH = 5;

/** Function words of French and English queries: they carry no lexical signal. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'does',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'au',
  'aux',
  'avec',
  'ce',
  'ces',
  'comment',
  'dans',
  'de',
  'des',
  'du',
  'elle',
  'en',
  'est',
  'et',
  'il',
  'la',
  'le',
  'les',
  'leur',
  'ou',
  'où',
  'par',
  'pour',
  'quel',
  'quelle',
  'quels',
  'quelles',
  'qui',
  'que',
  'quoi',
  'sa',
  'se',
  'ses',
  'son',
  'sont',
  'sur',
  'un',
  'une',
  'à',
  'on',
  'nous',
  'vous',
  'y',
]);

/** Extracts the significant terms of a free-text query (lowercased, deduplicated). */
export function queryTerms(query: string): string[] {
  const tokens =
    query
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? [];
  const terms = tokens.filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

/**
 * Builds a safe FTS5 expression (each term quoted, OR-ed: bm25 ranks documents matching more
 * and rarer terms first). Returns null when the query has no significant term.
 */
export function toFtsExpression(query: string): string | null {
  const terms = queryTerms(query);
  return terms.length === 0
    ? null
    : terms
        .map((term) => (term.length >= PREFIX_MIN_LENGTH ? `"${term}"*` : `"${term}"`))
        .join(' OR ');
}
