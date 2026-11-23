export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProjectMismatchError extends StorageError {
  constructor(path: string, expected: string, actual: string) {
    super(`Database "${path}" belongs to project "${actual}", not "${expected}".`);
  }
}

export class SchemaVersionError extends StorageError {
  constructor(path: string, actual: number, expected: number) {
    super(
      `Database "${path}" has schema version ${actual}, expected ${expected}: run "mdb index" first.`,
    );
  }
}
