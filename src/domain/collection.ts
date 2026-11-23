import type { ProjectId } from './project-id.js';

export interface EmbeddingModelRef {
  readonly model: string;
  readonly dimensions: number;
}

export interface CollectionNames {
  /** Physical collection: one per project AND per embedding model, never mixed. */
  readonly collection: string;
  /** Alias pointing at the active collection of the project. */
  readonly alias: string;
}

export function modelSlug(model: string): string {
  return model
    .toLowerCase()
    .replaceAll('.', '_')
    .replaceAll(/[^a-z0-9_]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

export function collectionNames(project: ProjectId, embedding: EmbeddingModelRef): CollectionNames {
  if (!Number.isInteger(embedding.dimensions) || embedding.dimensions <= 0) {
    throw new Error(`Invalid embedding dimensions ${embedding.dimensions}.`);
  }
  const slug = modelSlug(embedding.model);
  if (slug.length === 0) {
    throw new Error(`Invalid embedding model name "${embedding.model}".`);
  }
  return {
    collection: `md_${project}__${slug}_${embedding.dimensions}`,
    alias: `md_${project}`,
  };
}
