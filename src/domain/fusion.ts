export const DEFAULT_RRF_K = 60;

export interface RankedList {
  /** Name of the retriever that produced the list (e.g. `semantic`, `lexical`). */
  readonly source: string;
  /** Ids ordered from best to worst. Duplicates keep their best rank. */
  readonly ids: readonly string[];
  readonly weight?: number;
}

export interface FusedResult {
  readonly id: string;
  readonly score: number;
  /** 1-based rank of the id in each source list that contained it. */
  readonly ranks: Readonly<Record<string, number>>;
}

/**
 * Weighted Reciprocal Rank Fusion: score(d) = Σ weight / (k + rank). Ties are broken by the
 * number of contributing sources, then by id for determinism.
 */
export function reciprocalRankFusion(
  lists: readonly RankedList[],
  k: number = DEFAULT_RRF_K,
): FusedResult[] {
  if (!(k > 0)) {
    throw new Error(`Invalid RRF constant ${k}.`);
  }
  const scores = new Map<string, { score: number; ranks: Record<string, number> }>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    if (!(weight >= 0)) {
      throw new Error(`Invalid weight ${weight} for source "${list.source}".`);
    }
    list.ids.forEach((id, index) => {
      const entry = scores.get(id) ?? { score: 0, ranks: {} };
      if (entry.ranks[list.source] === undefined) {
        entry.ranks[list.source] = index + 1;
        entry.score += weight / (k + index + 1);
      }
      scores.set(id, entry);
    });
  }
  return [...scores.entries()]
    .map(([id, entry]) => ({ id, score: entry.score, ranks: entry.ranks }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Object.keys(b.ranks).length - Object.keys(a.ranks).length ||
        a.id.localeCompare(b.id),
    );
}
