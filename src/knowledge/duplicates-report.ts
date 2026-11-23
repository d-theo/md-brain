import type { RelationKind } from '../domain/model.js';
import type { ChunkContext, MetadataStore } from '../domain/ports.js';

export interface ChunkLocation {
  readonly chunkId: string;
  readonly location: string;
  readonly title: string | null;
}

export interface SuggestedPair {
  readonly kind: RelationKind;
  readonly score: number;
  readonly source: ChunkLocation;
  readonly target: ChunkLocation;
}

export interface DuplicatesReport {
  /** Identical chunks (same normalised content) found in several files. */
  readonly exactGroups: readonly (readonly ChunkLocation[])[];
  /** Near-duplicates and similar chunks suggested from embeddings, best scores first. */
  readonly suggested: readonly SuggestedPair[];
}

export const MIN_DUPLICATE_TOKENS = 20;

export function locate(context: ChunkContext): ChunkLocation {
  const { chunk, file } = context;
  return {
    chunkId: chunk.id,
    location: `${file.path}:L${chunk.startLine}-L${chunk.endLine}`,
    title: chunk.headingPath,
  };
}

/** Duplicate and similarity overview of a project, for review and calibration. */
export function duplicatesReport(
  store: MetadataStore,
  kinds: readonly RelationKind[],
  limit: number,
): DuplicatesReport {
  const groups = store.duplicateGroups(limit, MIN_DUPLICATE_TOKENS);
  const relations = store.topSuggestedRelations(kinds, limit);
  const contexts = store.getChunkContexts([
    ...groups.flat(),
    ...relations.flatMap((relation) => [relation.srcId, relation.dstRef]),
  ]);
  const at = (chunkId: string): ChunkLocation[] => {
    const context = contexts.get(chunkId);
    return context === undefined ? [] : [locate(context)];
  };
  return {
    exactGroups: groups.map((group) =>
      group.flatMap(at).sort((left, right) => left.location.localeCompare(right.location)),
    ),
    suggested: relations.flatMap((relation) =>
      at(relation.srcId).flatMap((source) =>
        at(relation.dstRef).map((target) => ({
          kind: relation.kind,
          score: relation.score ?? 0,
          source,
          target,
        })),
      ),
    ),
  };
}

export function formatDuplicatesReport(report: DuplicatesReport): string[] {
  const lines = ['Exact duplicates:'];
  if (report.exactGroups.length === 0) {
    lines.push('  none');
  }
  report.exactGroups.forEach((group, index) => {
    lines.push(`  ${index + 1}. ${group.length} copies`);
    for (const location of group) {
      lines.push(
        `     ${location.location}${location.title === null ? '' : `  ${location.title}`}`,
      );
    }
  });
  lines.push('Suggested (embeddings):');
  if (report.suggested.length === 0) {
    lines.push('  none');
  }
  report.suggested.forEach((pair, index) => {
    lines.push(`  ${index + 1}. ${pair.kind} ${pair.score.toFixed(3)}`);
    lines.push(
      `     ${pair.source.location}${pair.source.title === null ? '' : `  ${pair.source.title}`}`,
    );
    lines.push(
      `     ${pair.target.location}${pair.target.title === null ? '' : `  ${pair.target.title}`}`,
    );
  });
  return lines;
}
