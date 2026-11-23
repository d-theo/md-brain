import { describe, expect, it } from 'vitest';
import {
  RELATION_KINDS,
  RELATION_METHODS,
  RELATION_ORIGINS,
  RELATION_TARGETS,
} from '../../../src/domain/model.js';

describe('model', () => {
  describe.each([
    ['RELATION_KINDS', RELATION_KINDS],
    ['RELATION_ORIGINS', RELATION_ORIGINS],
    ['RELATION_METHODS', RELATION_METHODS],
    ['RELATION_TARGETS', RELATION_TARGETS],
  ])('%s', (_name, values) => {
    it('has unique snake-case values', () => {
      expect(new Set(values).size).toBe(values.length);
      for (const value of values) {
        expect(value).toMatch(/^[a-z][a-z_]*$/);
      }
    });
  });
});
