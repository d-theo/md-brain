import { QdrantClient } from '@qdrant/js-client-rest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectionNames } from '../../../src/domain/collection.js';
import { StorageError } from '../../../src/storage/errors.js';
import { QdrantVectorStore } from '../../../src/storage/qdrant/qdrant-vector-store.js';
import { aPoint, aVector, uniqueProjectId } from '../../support/fixtures.js';

const QDRANT_URL = process.env.MD_TEST_QDRANT_URL ?? 'http://localhost:6333';
const DIMENSIONS = 8;

describe('QdrantVectorStore', () => {
  const client = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });
  const projectA = uniqueProjectId();
  const projectB = uniqueProjectId();
  const namesA = collectionNames(projectA, { model: 'fake', dimensions: DIMENSIONS });
  const namesA2 = collectionNames(projectA, { model: 'fake-v2', dimensions: DIMENSIONS });
  const namesB = collectionNames(projectB, { model: 'fake', dimensions: DIMENSIONS });
  const storeA = new QdrantVectorStore(client, namesA, DIMENSIONS);
  const storeA2 = new QdrantVectorStore(client, namesA2, DIMENSIONS);
  const storeB = new QdrantVectorStore(client, namesB, DIMENSIONS);

  beforeAll(async () => {
    for (const store of [storeA, storeA2, storeB]) {
      await store.ensureCollection();
      await store.activateAlias();
    }
    await storeA.activateAlias();
  });

  afterAll(async () => {
    for (const names of [namesA, namesA2, namesB]) {
      await client.deleteCollection(names.collection);
    }
  });

  it('creates collections and indexes idempotently', async () => {
    await storeA.ensureCollection();
    await storeA.ensureCollection();

    const info = await client.getCollection(namesA.collection);
    expect(Object.keys(info.payload_schema).sort()).toEqual(['file_id', 'folders']);
  });

  it('refuses an existing collection with other dimensions', async () => {
    const wrong = new QdrantVectorStore(client, namesA, DIMENSIONS * 2);

    await expect(wrong.ensureCollection()).rejects.toThrow(StorageError);
  });

  it('switches the project alias atomically and idempotently', async () => {
    await storeA2.activateAlias();
    await storeA2.activateAlias();
    const switched = await client.getCollectionAliases(namesA2.collection);
    expect(switched.aliases.map((alias) => alias.alias_name)).toEqual([namesA.alias]);

    await storeA.activateAlias();
    const restored = await client.getCollectionAliases(namesA.collection);
    expect(restored.aliases.map((alias) => alias.alias_name)).toEqual([namesA.alias]);
    expect((await client.getCollectionAliases(namesA2.collection)).aliases).toEqual([]);
  });

  it('upserts, filters, searches and deletes points by file', async () => {
    const points = [
      aPoint(projectA, DIMENSIONS, 0, { fileId: 'f-root', path: 'README.md', folders: [] }),
      aPoint(projectA, DIMENSIONS, 1, { fileId: 'f-work' }),
      aPoint(projectA, DIMENSIONS, 2, {
        fileId: 'f-journal',
        path: 'journal/2026/11.md',
        folders: ['journal', 'journal/2026'],
      }),
    ];
    await storeA.upsert(points);
    await storeA.upsert(points);

    expect(await storeA.count()).toBe(3);
    expect(await storeA.count({ folders: ['journal'] })).toBe(1);
    const hits = await storeA.search(aVector(DIMENSIONS, 1), {}, 2);
    expect(hits[0]?.id).toBe(points[1]?.id);
    expect(hits[0]?.payload).toEqual(points[1]?.payload);
    expect(
      (
        await storeA.search(aVector(DIMENSIONS, 1), { folders: ['journal/2026', 'nowhere'] }, 5)
      ).map((hit) => hit.payload.fileId),
    ).toEqual(['f-journal']);
    expect(await storeA.search(aVector(DIMENSIONS, 1), { folders: [] }, 5)).toEqual([]);

    await storeA.deleteByFileIds(['f-work', 'f-journal']);

    expect(await storeA.count()).toBe(1);
    expect(await storeA.count({ fileIds: ['f-root'] })).toBe(1);
  });

  it('finds neighbours of a stored point, excluding files and weak matches', async () => {
    const points = [
      aPoint(projectA, DIMENSIONS, 4, { fileId: 'near-a' }),
      {
        ...aPoint(projectA, DIMENSIONS, 5, { fileId: 'near-b' }),
        vector: aVector(DIMENSIONS, 4, 0.02),
      },
      aPoint(projectA, DIMENSIONS, 6, { fileId: 'far' }),
    ];
    await storeA.upsert(points);
    const source = points[0]?.id ?? '';

    const hits = await storeA.similarTo(source, {}, 5, 0.9);
    const excluded = await storeA.similarTo(source, { excludeFileIds: ['near-b'] }, 5, 0.9);

    expect(hits.map((hit) => hit.payload.fileId)).toEqual(['near-b']);
    expect(excluded).toEqual([]);
    await storeA.deleteByFileIds(['near-a', 'near-b', 'far']);
  });

  it('keeps projects isolated', async () => {
    await storeB.upsert([aPoint(projectB, DIMENSIONS, 3, { fileId: 'b-only' })]);

    const fromA = await storeA.search(aVector(DIMENSIONS, 3), {}, 10);
    const fromB = await storeB.search(aVector(DIMENSIONS, 3), {}, 10);
    expect(fromA.map((hit) => hit.payload.fileId)).not.toContain('b-only');
    expect(fromB.map((hit) => hit.payload.fileId)).toEqual(['b-only']);
  });

  it('rejects vectors of the wrong size', async () => {
    const point = { ...aPoint(projectA, DIMENSIONS, 0), vector: [1, 2] };

    await expect(storeA.upsert([point])).rejects.toThrow('has 2 dimensions, expected 8');
  });

  it.each([0, 201, 1.5])('rejects the invalid search limit %s', async (limit) => {
    await expect(storeA.search(aVector(DIMENSIONS, 0), {}, limit)).rejects.toThrow(
      `Invalid search limit ${limit}`,
    );
  });
});
