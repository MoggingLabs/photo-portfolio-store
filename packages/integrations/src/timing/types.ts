// F4.6/F4.7/F4.8 — timing-provider adapter interface.
//
// A timing provider (RunSignup, ChronoTrack, MyLaps) supplies a participant
// roster before race day and finish-time events during the race. Each provider
// implements TimingProviderAdapter so the sync worker stays provider-agnostic;
// RunSignup is the reference implementation (F4.6) and the others reuse the
// interface (F4.7/F4.8).

export type TimingProvider = 'runsignup' | 'chronotrack' | 'mylaps';

export interface RosterEntry {
  bib: string;
  firstName: string;
  lastName: string;
  email?: string;
  age?: number;
  gender?: string;
  division?: string;
}

export interface FinishEventRecord {
  bib: string;
  splitName: string;
  gunTimeMs?: number;
  chipTimeMs?: number;
  recordedAt: Date;
  // Raw provider payload retained for debugging (30-day retention policy).
  raw: Record<string, unknown>;
}

export type TimingErrorCode = 'auth' | 'rate_limited' | 'not_found' | 'transient' | 'invalid';

export class TimingProviderError extends Error {
  constructor(
    public readonly code: TimingErrorCode,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'TimingProviderError';
  }
}

export interface PullFinishOptions {
  // Only return events at or after this time (incremental polling).
  since?: Date;
}

export interface TimingProviderAdapter {
  readonly provider: TimingProvider;
  pullRoster(externalEventId: string): Promise<RosterEntry[]>;
  pullFinishEvents(externalEventId: string, opts?: PullFinishOptions): Promise<FinishEventRecord[]>;
}

// Shared HTTP client contract (injectable so adapters are fixture-testable).
export interface TimingHttpResponse {
  status: number;
  body: unknown;
}

export type TimingHttpClient = (
  url: string,
  headers: Record<string, string>,
) => Promise<TimingHttpResponse>;

export const timingErrorForStatus = (status: number, message: string): TimingProviderError => {
  if (status === 401 || status === 403) return new TimingProviderError('auth', message);
  if (status === 404) return new TimingProviderError('not_found', message);
  if (status === 429) return new TimingProviderError('rate_limited', message, true);
  if (status >= 500) return new TimingProviderError('transient', message, true);
  return new TimingProviderError('invalid', message);
};
