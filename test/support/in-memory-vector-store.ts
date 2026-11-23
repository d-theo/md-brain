import type { SearchFilter, VectorHit, VectorPoint, VectorStore } from '../../src/domain/ports.js';

function matches(point: VectorPoint, filter: SearchFilter): boolean {
  const { payload } = point;
  return (
    (filter.folders === undefined ||
      filter.folders.some((folder) => payload.folders.includes(folder))) &&
    (filter.fileIds === undefined || filter.fileIds.includes(payload.fileId)) &&
    !(filter.excludeFileIds ?? []).includes(payload.fileId)
  );
}

function cosine(a: readonly number[], b: readonly number[]): number {
  const dot = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
  return dot / ((Math.hypot(...a) || 1) * (Math.hypot(...b) || 1));
}

/** VectorStore for unit tests: brute-force cosine search over a Map. */
export class InMemoryVectorStore implements VectorStore {
  readonly points = new Map<string, VectorPoint>();
  aliasActive = false;

  async ensureCollection(): Promise<void> {}

  async activateAlias(): Promise<void> {
    this.aliasActive = true;
  }

  async upsert(points: readonly VectorPoint[]): Promise<void> {
    for (const point of points) {
      this.points.set(point.id, point);
    }
  }

  async deleteByFileIds(fileIds: readonly string[]): Promise<void> {
    for (const [id, point] of this.points) {
      if (fileIds.includes(point.payload.fileId)) {
        this.points.delete(id);
      }
    }
  }

  async search(
    vector: readonly number[],
    filter: SearchFilter,
    limit: number,
  ): Promise<VectorHit[]> {
    return [...this.points.values()]
      .filter((point) => matches(point, filter))
      .map((point) => ({
        id: point.id,
        score: cosine(vector, point.vector),
        payload: point.payload,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async similarTo(
    pointId: string,
    filter: SearchFilter,
    limit: number,
    minScore: number,
  ): Promise<VectorHit[]> {
    const point = this.points.get(pointId);
    if (point === undefined) {
      return [];
    }
    return (await this.search(point.vector, filter, limit + 1))
      .filter((hit) => hit.id !== pointId && hit.score >= minScore)
      .slice(0, limit);
  }

  async count(filter: SearchFilter = {}): Promise<number> {
    return [...this.points.values()].filter((point) => matches(point, filter)).length;
  }
}
