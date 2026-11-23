import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QdrantClient } from '@qdrant/js-client-rest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, resetProject } from '../../../cli/runtime.js';
import type { ProjectConfig } from '../../../src/config/project-config.js';
import { QDRANT_URL } from '../../support/e2e-project.js';
import { uniqueProjectId } from '../../support/fixtures.js';
import { aProjectConfig } from '../../support/project-config.js';

describe('runtime', () => {
  let dir: string;
  let project: ProjectConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'md-runtime-'));
    project = { ...aProjectConfig(uniqueProjectId(), dir), qdrant: { url: QDRANT_URL } };
  });

  afterEach(async () => {
    await resetProject(project);
    rmSync(dir, { recursive: true, force: true });
  });

  describe('createRuntime', () => {
    it('wires the adapters of a project', async () => {
      const runtime = createRuntime(project);

      expect(runtime.embeddings.model).toBe(project.embeddings.model);
      expect(runtime.store.listFiles()).toEqual([]);
      await runtime.vectors.ensureCollection();
      runtime.close();
      runtime.close();

      const reader = createRuntime(project, { readOnly: true });
      expect(() => reader.store.setMeta('k', 'v')).toThrow();
      reader.close();
    });
  });

  describe('resetProject', () => {
    it('drops the collection and the SQLite files of the project', async () => {
      const runtime = createRuntime(project);
      await runtime.vectors.ensureCollection();
      runtime.close();

      await resetProject(project);
      await resetProject(project);

      const client = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });
      expect((await client.collectionExists(project.collection.collection)).exists).toBe(false);
      expect(existsSync(project.sqlitePath)).toBe(false);
    });
  });
});
