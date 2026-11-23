export const RELATION_KINDS = ['md_link', 'duplicate_of', 'similar_to'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/** `deterministic` links are facts extracted from notes; `suggested` ones are scored guesses. */
export const RELATION_ORIGINS = ['deterministic', 'suggested'] as const;
export type RelationOrigin = (typeof RELATION_ORIGINS)[number];

export const RELATION_METHODS = ['markdown', 'embedding'] as const;
export type RelationMethod = (typeof RELATION_METHODS)[number];

/** What a relation points at: a note path (Markdown link) or a chunk (similarity). */
export const RELATION_TARGETS = ['file', 'chunk'] as const;
export type RelationTarget = (typeof RELATION_TARGETS)[number];
