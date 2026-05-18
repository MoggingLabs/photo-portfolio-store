// F1.33 — soft-bind check for stolen-consent_id mitigation.
//
// We compare a stored {ip_hash, user_agent} pair (captured at grant time)
// to the current request's pair. The check intentionally tolerates one of
// the two changing — the common legitimate case is a phone switching
// between mobile data and wifi (IP changes, UA stays the same). Only when
// BOTH change does the binding fail.
//
// The caller decides what to do with the result: 'match' and 'partial' are
// accepted; 'mismatch' triggers an audit + reject.

export type SoftBindResult = 'match' | 'partial' | 'mismatch';

export interface SoftBindPair {
  ipHash?: string | null;
  userAgent?: string | null;
}

const normalize = (value: string | null | undefined): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
};

export const softBindMatch = (stored: SoftBindPair, current: SoftBindPair): SoftBindResult => {
  const storedIp = normalize(stored.ipHash);
  const storedUa = normalize(stored.userAgent);
  const currentIp = normalize(current.ipHash);
  const currentUa = normalize(current.userAgent);

  // If we recorded nothing at grant time, we cannot enforce a bind. Treat
  // as 'partial' so the caller can decide policy. The current pattern is to
  // accept partial — see services/consents.ts.
  if (!storedIp && !storedUa) return 'partial';

  const ipMatch = !!storedIp && !!currentIp && storedIp === currentIp;
  const uaMatch = !!storedUa && !!currentUa && storedUa === currentUa;

  if (ipMatch && uaMatch) return 'match';
  if (ipMatch || uaMatch) return 'partial';
  return 'mismatch';
};
