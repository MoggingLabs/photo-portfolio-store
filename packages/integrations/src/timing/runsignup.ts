// F4.6 — RunSignup timing adapter (reference implementation).
//
// Pulls the participant roster and finish-time results from RunSignup. The HTTP
// client is injectable so this is unit-testable against fixtures. NOTE: the
// exact RunSignup response shapes below follow their published API conventions
// but have NOT been verified against a live race in this environment — confirm
// field names during onboarding. Auth: API key in the X-RSU-API-KEY header
// (stored encrypted per F4.1).

import {
  type FinishEventRecord,
  type PullFinishOptions,
  type RosterEntry,
  type TimingHttpClient,
  type TimingProviderAdapter,
  timingErrorForStatus,
} from './types.js';

const DEFAULT_BASE_URL = 'https://runsignup.com/Rest';

export interface RunSignupOptions {
  apiKey: string;
  baseUrl?: string;
  httpClient: TimingHttpClient;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

// Parse a "HH:MM:SS.mmm" or "MM:SS" clock string to milliseconds.
export const parseClockToMs = (clock: unknown): number | undefined => {
  if (typeof clock !== 'string' || clock.trim() === '') return undefined;
  const parts = clock.split(':').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + (p as number);
  return Math.round(seconds * 1000);
};

export class RunSignupAdapter implements TimingProviderAdapter {
  readonly provider = 'runsignup' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly http: TimingHttpClient;

  constructor(opts: RunSignupOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.http = opts.httpClient;
  }

  private headers(): Record<string, string> {
    return { 'X-RSU-API-KEY': this.apiKey, accept: 'application/json' };
  }

  async pullRoster(raceId: string): Promise<RosterEntry[]> {
    const res = await this.http(
      `${this.baseUrl}/race/${raceId}/participants?format=json`,
      this.headers(),
    );
    if (res.status !== 200)
      throw timingErrorForStatus(res.status, `runsignup roster ${res.status}`);
    const body = (res.body ?? {}) as { participants?: unknown[] };
    const list = Array.isArray(body.participants) ? body.participants : [];
    const entries: RosterEntry[] = [];
    for (const raw of list) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const user = (p.user ?? {}) as Record<string, unknown>;
      const bib = str(p.bib_num ?? p.bib);
      if (bib === '') continue; // DNS / unassigned bib — skip
      const entry: RosterEntry = {
        bib,
        firstName: str(user.first_name),
        lastName: str(user.last_name),
      };
      const email = str(user.email);
      if (email) entry.email = email.toLowerCase();
      const age = num(p.age);
      if (age !== undefined) entry.age = age;
      const gender = str(user.gender);
      if (gender) entry.gender = gender;
      const division = str(p.division);
      if (division) entry.division = division;
      entries.push(entry);
    }
    return entries;
  }

  async pullFinishEvents(
    raceId: string,
    opts: PullFinishOptions = {},
  ): Promise<FinishEventRecord[]> {
    const res = await this.http(
      `${this.baseUrl}/race/${raceId}/results?format=json`,
      this.headers(),
    );
    if (res.status !== 200)
      throw timingErrorForStatus(res.status, `runsignup results ${res.status}`);
    const body = (res.body ?? {}) as { results?: unknown[] };
    const list = Array.isArray(body.results) ? body.results : [];
    const out: FinishEventRecord[] = [];
    for (const raw of list) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const bib = str(r.bib_num ?? r.bib);
      if (bib === '') continue;
      const recordedAt = r.recorded_at ? new Date(str(r.recorded_at)) : new Date();
      if (opts.since && recordedAt < opts.since) continue;
      const rec: FinishEventRecord = {
        bib,
        splitName: str(r.split_name ?? 'finish') || 'finish',
        recordedAt,
        raw: r,
      };
      const gun = parseClockToMs(r.gun_time ?? r.clock_time);
      if (gun !== undefined) rec.gunTimeMs = gun;
      const chip = parseClockToMs(r.chip_time);
      if (chip !== undefined) rec.chipTimeMs = chip;
      out.push(rec);
    }
    return out;
  }
}
