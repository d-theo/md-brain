import type { SQLOutputValue } from 'node:sqlite';
import { StorageError } from '../errors.js';

export type Row = Record<string, SQLOutputValue>;

function invalid(column: string, expected: string, value: SQLOutputValue | undefined): never {
  throw new StorageError(`Column "${column}": expected ${expected}, got ${typeof value}.`);
}

export function text(row: Row, column: string): string {
  const value = row[column];
  return typeof value === 'string' ? value : invalid(column, 'text', value);
}

export function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  return value === null ? null : text(row, column);
}

export function int(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return invalid(column, 'integer', value);
}

export function real(row: Row, column: string): number {
  const value = row[column];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : invalid(column, 'real', value);
}

export function intOrNull(row: Row, column: string): number | null {
  return row[column] === null ? null : int(row, column);
}

export function bool(row: Row, column: string): boolean {
  return int(row, column) !== 0;
}

export function blob(row: Row, column: string): Uint8Array {
  const value = row[column];
  return value instanceof Uint8Array ? value : invalid(column, 'blob', value);
}

/** Narrows a text column to one of the allowed literal values. */
export function oneOf<T extends string>(row: Row, column: string, allowed: readonly T[]): T {
  const value = text(row, column);
  const match = allowed.find((candidate) => candidate === value);
  return match ?? invalid(column, `one of ${allowed.join('|')}`, value);
}

export function encodeVector(vector: readonly number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

export function decodeVector(bytes: Uint8Array): number[] {
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new StorageError(`Invalid vector blob of ${bytes.byteLength} bytes.`);
  }
  const copy = bytes.slice();
  return Array.from(
    new Float32Array(copy.buffer, 0, copy.byteLength / Float32Array.BYTES_PER_ELEMENT),
  );
}
