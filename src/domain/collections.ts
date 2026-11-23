/** Pairs two arrays of the same length; a length mismatch is a programming error. */
export function zipStrict<A, B>(left: readonly A[], right: readonly B[]): [A, B][] {
  const mismatch = () =>
    new RangeError(`Cannot zip arrays of length ${left.length} and ${right.length}.`);
  const others = right[Symbol.iterator]();
  const pairs: [A, B][] = [];
  for (const value of left) {
    const other = others.next();
    if (other.done === true) {
      throw mismatch();
    }
    pairs.push([value, other.value]);
  }
  if (others.next().done !== true) {
    throw mismatch();
  }
  return pairs;
}

/** Reads a key that must be present. */
export function getOrThrow<K, V>(map: ReadonlyMap<K, V>, key: K, what: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new RangeError(`Missing ${what} for ${String(key)}.`);
  }
  return value;
}

/** Last element of a split string (`a/b/c` -> `c`); the whole string when no separator. */
export function lastPart(value: string, separator: string): string {
  return value.slice(value.lastIndexOf(separator) + 1);
}
