// Secret redaction for logs and API responses (F4.1).
//
// Connector credentials must never appear in logs, even at debug level. This
// helper deep-clones an arbitrary value and masks any property whose key looks
// secret. Use it on anything derived from integration_configs before logging.

export const SENSITIVE_KEY_RE =
  /(credential|secret|token|api[-_]?key|password|passphrase|private[-_]?key|authorization|bearer|hmac|signing[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|webhook[-_]?secret)/i;

const MASK = '[REDACTED]';

/**
 * Return a deep copy of `value` with every property whose key matches
 * {@link SENSITIVE_KEY_RE} replaced by a mask. Arrays and nested objects are
 * traversed; non-objects are returned unchanged. Cycle-safe.
 */
export const redactSecrets = <T>(value: T, seen: WeakSet<object> = new WeakSet()): T => {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, seen)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? MASK : redactSecrets(val, seen);
  }
  return out as T;
};
