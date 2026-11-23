import { InvalidProjectIdError } from './errors.js';

declare const projectIdBrand: unique symbol;

/** Identifier of an isolated project (one SQLite file, one Qdrant alias). */
export type ProjectId = string & { readonly [projectIdBrand]: true };

export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

export function isProjectId(value: string): value is ProjectId {
  return PROJECT_ID_PATTERN.test(value);
}

export function toProjectId(value: string): ProjectId {
  if (!isProjectId(value)) {
    throw new InvalidProjectIdError(value);
  }
  return value;
}
