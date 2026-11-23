import { describe, expect, it } from 'vitest';
import { InvalidProjectIdError } from '../../../src/domain/errors.js';
import { isProjectId, toProjectId } from '../../../src/domain/project-id.js';

describe('project-id', () => {
  describe('isProjectId', () => {
    it.each(['contentmoderation', 'stats-reminder', 'p1'])('accepts %s', (value) => {
      expect(isProjectId(value)).toBe(true);
    });

    it.each(['', 'a', 'Content', '1project', 'with_underscore', '../x', 'a'.repeat(64)])(
      'rejects %j',
      (value) => {
        expect(isProjectId(value)).toBe(false);
      },
    );
  });

  describe('toProjectId', () => {
    it('returns the validated id', () => {
      expect(toProjectId('contentmoderation')).toBe('contentmoderation');
    });

    it('throws on an invalid id', () => {
      expect(() => toProjectId('Bad Id')).toThrow(InvalidProjectIdError);
      expect(() => toProjectId('Bad Id')).toThrow('Invalid project id "Bad Id"');
    });
  });
});
