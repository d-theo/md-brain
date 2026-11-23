import { describe, expect, it } from 'vitest';
import { collectionNames, modelSlug } from '../../../src/domain/collection.js';
import { toProjectId } from '../../../src/domain/project-id.js';

const project = toProjectId('contentmoderation');

describe('collection', () => {
  describe('modelSlug', () => {
    it.each([
      ['qwen3-embedding:0.6b', 'qwen3-embedding-0_6b'],
      ['Qwen3-Embedding:4B', 'qwen3-embedding-4b'],
      ['hf.co/org/model:Q4', 'hf_co-org-model-q4'],
      [':weird:', 'weird'],
    ])('slugifies %s to %s', (model, slug) => {
      expect(modelSlug(model)).toBe(slug);
    });
  });

  describe('collectionNames', () => {
    it('names one collection per project and model, behind a project alias', () => {
      expect(collectionNames(project, { model: 'qwen3-embedding:0.6b', dimensions: 1024 })).toEqual(
        {
          collection: 'md_contentmoderation__qwen3-embedding-0_6b_1024',
          alias: 'md_contentmoderation',
        },
      );
    });

    it('never shares a collection between two models or dimensions', () => {
      const a = collectionNames(project, { model: 'qwen3-embedding:0.6b', dimensions: 1024 });
      const b = collectionNames(project, { model: 'qwen3-embedding:4b', dimensions: 1024 });
      const c = collectionNames(project, { model: 'qwen3-embedding:0.6b', dimensions: 512 });

      expect(new Set([a.collection, b.collection, c.collection]).size).toBe(3);
      expect(new Set([a.alias, b.alias, c.alias]).size).toBe(1);
    });

    it.each([0, -1, 1.5])('rejects invalid dimensions %s', (dimensions) => {
      expect(() => collectionNames(project, { model: 'm', dimensions })).toThrow(
        `Invalid embedding dimensions ${dimensions}.`,
      );
    });

    it('rejects a model name without usable characters', () => {
      expect(() => collectionNames(project, { model: '::', dimensions: 8 })).toThrow(
        'Invalid embedding model name "::".',
      );
    });
  });
});
