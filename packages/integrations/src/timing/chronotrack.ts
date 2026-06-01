// F4.7 — ChronoTrack timing adapter.
//
// Same shape as RunSignup but speaks the ChronoTrack Live API with HTTP Basic
// auth (username + user_token) and paginated roster pulls. The credential
// string is "username:user_token". Response shapes follow ChronoTrack
// conventions but are NOT live-verified here — confirm during onboarding.

import {
  type FinishEventRecord,
  type PullFinishOptions,
  type RosterEntry,
  type TimingHttpClient,
  type TimingProviderAdapter,
  timingErrorForStatus,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.chronotrack.com/api';
const PAGE_SIZE = 50;
const MAX_PAGES = 200; // safety bound (~10k participants)

export interface ChronoTrackOptions {
  username: string;
  userToken: string;
  baseUrl?: string;
  httpClient: TimingHttpClient;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const numOrUndef = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

export class ChronoTrackAdapter implements TimingProviderAdapter {
  readonly provider = 'chronotrack' as const;
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly http: TimingHttpClient;

  constructor(opts: ChronoTrackOptions) {
    this.authHeader = `Basic ${Buffer.from(`${opts.username}:${opts.userToken}`).toString('base64')}`;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.http = opts.httpClient;
  }

  private headers(): Record<string, string> {
    return { authorization: this.authHeader, accept: 'application/json' };
  }

  async pullRoster(eventId: string): Promise<RosterEntry[]> {
    const entries: RosterEntry[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await this.http(
        `${this.baseUrl}/event/${eventId}/entry?format=json&page=${page}&size=${PAGE_SIZE}`,
        this.headers(),
      );
      if (res.status !== 200)
        throw timingErrorForStatus(res.status, `chronotrack roster ${res.status}`);
      const body = (res.body ?? {}) as { event_entry?: unknown[] };
      const list = Array.isArray(body.event_entry) ? body.event_entry : [];
      if (list.length === 0) break; // pagination complete
      for (const raw of list) {
        const e = (raw ?? {}) as Record<string, unknown>;
        const bib = str(e.entry_bib ?? e.bib);
        if (bib === '') continue;
        const entry: RosterEntry = {
          bib,
          firstName: str(e.entry_first_name ?? e.first_name),
          lastName: str(e.entry_last_name ?? e.last_name),
        };
        const email = str(e.entry_email ?? e.email);
        if (email) entry.email = email.toLowerCase();
        const gender = str(e.entry_sex ?? e.gender);
        if (gender) entry.gender = gender;
        entries.push(entry);
      }
      if (list.length < PAGE_SIZE) break;
    }
    return entries;
  }

  async pullFinishEvents(
    eventId: string,
    opts: PullFinishOptions = {},
  ): Promise<FinishEventRecord[]> {
    const res = await this.http(
      `${this.baseUrl}/event/${eventId}/results?format=json`,
      this.headers(),
    );
    if (res.status !== 200)
      throw timingErrorForStatus(res.status, `chronotrack results ${res.status}`);
    const body = (res.body ?? {}) as { results?: unknown[] };
    const list = Array.isArray(body.results) ? body.results : [];
    const out: FinishEventRecord[] = [];
    for (const raw of list) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const bib = str(r.results_bib ?? r.bib);
      if (bib === '') continue;
      const recordedAt = r.results_time_recorded
        ? new Date(str(r.results_time_recorded))
        : new Date();
      if (opts.since && recordedAt < opts.since) continue;
      const rec: FinishEventRecord = {
        bib,
        splitName: str(r.results_split ?? 'finish') || 'finish',
        recordedAt,
        raw: r,
      };
      // ChronoTrack chip times are authoritative; values are in milliseconds.
      const chip = numOrUndef(r.results_time_ms ?? r.chip_time_ms);
      if (chip !== undefined) rec.chipTimeMs = chip;
      const gun = numOrUndef(r.results_gun_time_ms ?? r.gun_time_ms);
      if (gun !== undefined) rec.gunTimeMs = gun;
      out.push(rec);
    }
    return out;
  }
}
