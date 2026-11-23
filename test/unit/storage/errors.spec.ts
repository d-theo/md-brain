import { describe, expect, it } from 'vitest';
import {
  ProjectMismatchError,
  SchemaVersionError,
  StorageError,
} from '../../../src/storage/errors.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../../../src/storage/sqlite/schema.js';

describe('storage errors', () => {
  it('describes a project mismatch', () => {
    const error = new ProjectMismatchError('/db', 'a', 'b');

    expect(error).toBeInstanceOf(StorageError);
    expect(error.name).toBe('ProjectMismatchError');
    expect(error.message).toBe('Database "/db" belongs to project "b", not "a".');
  });

  it('describes a schema version mismatch', () => {
    expect(new SchemaVersionError('/db', 0, SCHEMA_VERSION).message).toContain(
      `has schema version 0, expected ${SCHEMA_VERSION}`,
    );
  });

  it('versions the schema by its number of migrations', () => {
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });
});
