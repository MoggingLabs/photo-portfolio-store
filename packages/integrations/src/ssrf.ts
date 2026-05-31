// SSRF guard for outbound webhook / connector target URLs (F4.11).
//
// Rejects non-HTTPS URLs (HTTP allowed only when explicitly opted in for local
// dev) and any URL whose host is a loopback / private / link-local / cloud
// metadata address. This is a literal-host check: it blocks the common cases
// (localhost, 127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16 incl.
// 169.254.169.254, ::1, fc00::/7, fe80::/10). DNS rebinding to a private IP
// after this check is a documented residual risk — the worker re-checks at
// send time, but full mitigation needs pinned resolution.

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface AssertUrlOptions {
  /** Permit http:// (local dev only). Defaults to false (https required). */
  allowHttp?: boolean;
}

const isPrivateIpv4 = (host: string): boolean => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1, 5).map(Number) as [number, number, number, number];
  if (o.some((n) => n > 255)) return true; // malformed -> reject
  const [a, b] = o;
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
};

const normalizeIpv6 = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

const isPrivateIpv6 = (raw: string): boolean => {
  const host = normalizeIpv6(raw).toLowerCase();
  if (!host.includes(':')) return false;
  if (host === '::1' || host === '::') return true; // loopback / unspecified
  if (host.startsWith('fe80')) return true; // link-local
  if (host.startsWith('fc') || host.startsWith('fd')) return true; // unique-local fc00::/7
  // IPv4-mapped (::ffff:127.0.0.1)
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (v4?.[1]) return isPrivateIpv4(v4[1]);
  return false;
};

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);

/**
 * Throw SsrfError if `url` is not a safe public HTTPS target.
 */
export const assertPublicHttpsUrl = (url: string, opts: AssertUrlOptions = {}): void => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError('invalid URL');
  }

  const okProtocol =
    parsed.protocol === 'https:' || (opts.allowHttp && parsed.protocol === 'http:');
  if (!okProtocol) {
    throw new SsrfError(`only https URLs are allowed (got ${parsed.protocol})`);
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new SsrfError(`blocked host: ${host}`);
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    throw new SsrfError(`blocked private/loopback address: ${host}`);
  }
};
