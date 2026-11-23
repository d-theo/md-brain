import type { QdrantClient } from '@qdrant/js-client-rest';
import type { CollectionNames } from '../../domain/collection.js';
import type { SearchFilter, VectorHit, VectorPoint, VectorStore } from '../../domain/ports.js';
import { StorageError } from '../errors.js';
import {
  fromQdrantPayload,
  PAYLOAD_INDEXES,
  toQdrantFilter,
  toQdrantPayload,
} from './qdrant-mapping.js';

export const DENSE_VECTOR = 'dense';
const UPSERT_BATCH = 128;
const DELETE_BATCH = 256;
const MAX_LIMIT = 200;
/**
 * Exact (brute-force) search: per-project collections hold thousands of vectors, so it costs a few
 * milliseconds and keeps results deterministic once HNSW kicks in (approximate otherwise).
 */
const EXACT_SEARCH = { exact: true };

/**
 * Vectors of ONE project for ONE embedding model. Writes go to the physical collection, reads
 * go through the project alias, so a rebuild can fill a new collection before switching.
 */
export class QdrantVectorStore implements VectorStore {
  constructor(
    private readonly client: QdrantClient,
    private readonly names: CollectionNames,
    private readonly dimensions: number,
  ) {}

  async ensureCollection(): Promise<void> {
    const { collection } = this.names;
    const { exists } = await this.client.collectionExists(collection);
    if (exists) {
      await this.assertDimensions();
    } else {
      await this.client.createCollection(collection, {
        vectors: { [DENSE_VECTOR]: { size: this.dimensions, distance: 'Cosine' } },
      });
    }
    for (const index of PAYLOAD_INDEXES) {
      await this.client.createPayloadIndex(collection, {
        field_name: index.field,
        field_schema: index.schema,
        wait: true,
      });
    }
  }

  /** Deletes this store's collection (rebuild); the alias of the project goes with it. */
  async drop(): Promise<void> {
    const { exists } = await this.client.collectionExists(this.names.collection);
    if (exists) {
      await this.client.deleteCollection(this.names.collection);
    }
  }

  async activateAlias(): Promise<void> {
    const { alias, collection } = this.names;
    const { aliases } = await this.client.getAliases();
    const current = aliases.find((entry) => entry.alias_name === alias);
    if (current?.collection_name === collection) {
      return;
    }
    await this.client.updateCollectionAliases({
      actions: [
        ...(current === undefined ? [] : [{ delete_alias: { alias_name: alias } }]),
        { create_alias: { collection_name: collection, alias_name: alias } },
      ],
    });
  }

  async upsert(points: readonly VectorPoint[]): Promise<void> {
    for (const point of points) {
      if (point.vector.length !== this.dimensions) {
        throw new StorageError(
          `Vector of point ${point.id} has ${point.vector.length} dimensions, expected ${this.dimensions}.`,
        );
      }
    }
    for (let index = 0; index < points.length; index += UPSERT_BATCH) {
      await this.client.upsert(this.names.collection, {
        wait: true,
        points: points.slice(index, index + UPSERT_BATCH).map((point) => ({
          id: point.id,
          vector: { [DENSE_VECTOR]: [...point.vector] },
          payload: { ...toQdrantPayload(point.payload) },
        })),
      });
    }
  }

  async deleteByFileIds(fileIds: readonly string[]): Promise<void> {
    for (let index = 0; index < fileIds.length; index += DELETE_BATCH) {
      await this.client.delete(this.names.collection, {
        wait: true,
        filter: toQdrantFilter({ fileIds: fileIds.slice(index, index + DELETE_BATCH) }),
      });
    }
  }

  async search(
    vector: readonly number[],
    filter: SearchFilter,
    limit: number,
  ): Promise<VectorHit[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      throw new StorageError(`Invalid search limit ${limit} (1..${MAX_LIMIT}).`);
    }
    const { points } = await this.client.query(this.names.alias, {
      query: [...vector],
      using: DENSE_VECTOR,
      filter: toQdrantFilter(filter),
      limit,
      with_payload: true,
      params: EXACT_SEARCH,
    });
    return points.map((point) => ({
      id: String(point.id),
      score: point.score,
      payload: fromQdrantPayload(point.payload),
    }));
  }

  async similarTo(
    pointId: string,
    filter: SearchFilter,
    limit: number,
    minScore: number,
  ): Promise<VectorHit[]> {
    const { points } = await this.client.query(this.names.collection, {
      query: pointId,
      using: DENSE_VECTOR,
      filter: toQdrantFilter(filter),
      limit,
      score_threshold: minScore,
      with_payload: true,
      params: EXACT_SEARCH,
    });
    return points
      .filter((point) => String(point.id) !== pointId)
      .map((point) => ({
        id: String(point.id),
        score: point.score,
        payload: fromQdrantPayload(point.payload),
      }));
  }

  /** Counts points of the physical collection. */
  async count(filter: SearchFilter = {}): Promise<number> {
    const { count } = await this.client.count(this.names.collection, {
      filter: toQdrantFilter(filter),
      exact: true,
    });
    return count;
  }

  private async assertDimensions(): Promise<void> {
    const info = await this.client.getCollection(this.names.collection);
    const vectors = info.config.params.vectors;
    const dense = vectors !== undefined && !('size' in vectors) ? vectors[DENSE_VECTOR] : undefined;
    if (dense?.size !== this.dimensions) {
      throw new StorageError(
        `Collection "${this.names.collection}" does not have a ${this.dimensions}-dimension "${DENSE_VECTOR}" vector.`,
      );
    }
  }
}
