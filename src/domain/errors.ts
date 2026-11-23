export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidProjectIdError extends DomainError {
  constructor(value: string) {
    super(`Invalid project id "${value}": expected lowercase letters, digits and dashes.`);
  }
}

export class InvalidRelativePathError extends DomainError {
  constructor(value: string, reason: string) {
    super(`Invalid relative path "${value}": ${reason}.`);
  }
}

/** Message of an unknown thrown value, without assuming it is an Error. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class EmbeddingModelMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(
      `This index was built with embedding model ${expected}, not ${actual}: rebuild the project to change model.`,
    );
  }
}
