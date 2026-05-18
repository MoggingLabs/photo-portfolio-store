// Canonical JSON serialization for deterministic hashing.
//
// RFC 8785-style stable encoding: object keys sorted lexicographically,
// no insignificant whitespace, JSON.stringify-equivalent value escaping.
// Used by writeAudit() to compute payload_hash so two semantically equal
// payloads always hash to the same value regardless of key insertion order.

/**
 * Produce a canonical JSON string for `value`.
 *
 * Rules:
 * - Objects: keys sorted ascending by codepoint.
 * - Arrays: order preserved.
 * - Primitives: JSON.stringify (handles strings/numbers/booleans/null).
 * - undefined values inside objects are dropped (matches JSON.stringify).
 *
 * Throws on cycles via the recursive call stack — callers should not pass
 * circular structures.
 */
export const canonicalize = (value: unknown): string => {
  if (value === undefined) {
    // Top-level undefined serializes to 'null' for stability; this is rarely
    // hit because writeAudit() short-circuits when payload is undefined.
    return 'null';
  }
  if (value === null) return 'null';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      // JSON spec forbids NaN/Infinity. Encode as null to keep canonical
      // output valid JSON.
      return 'null';
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const parts = value.map((item) => (item === undefined ? 'null' : canonicalize(item)));
    return `[${parts.join(',')}]`;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(',')}}`;
  }

  // Functions, symbols, bigints — coerce to null for safety.
  return 'null';
};
