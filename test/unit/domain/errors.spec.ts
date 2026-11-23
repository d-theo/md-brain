import { describe, expect, it } from 'vitest';
import { DomainError, describeError, InvalidProjectIdError } from '../../../src/domain/errors.js';

describe('errors', () => {
  describe('DomainError', () => {
    it('names errors after their concrete class', () => {
      const error = new InvalidProjectIdError('X');

      expect(error).toBeInstanceOf(DomainError);
      expect(error.name).toBe('InvalidProjectIdError');
    });
  });

  describe('describeError', () => {
    it('returns the message of an Error', () => {
      expect(describeError(new Error('boom'))).toBe('boom');
    });

    it('stringifies any other thrown value', () => {
      expect(describeError('boom')).toBe('boom');
      expect(describeError(42)).toBe('42');
    });
  });
});
