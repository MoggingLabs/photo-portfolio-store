// F4.8 — MyLaps timing adapter (cycling / motorsport / triathlon).
//
// OAuth2 client-credentials: exchanges clientId:clientSecret for a bearer token
// (cached until ~expiry), then pulls the roster (with transponder ids) and
// transponder passings. Each passing becomes a finish_event with
// split_name='lap_N' so multi-lap events record one row per crossing. The HTTP
// client is injectable. Response shapes follow MyLaps conventions but are NOT
// live-verified here — confirm during onboarding.

import {
  type FinishEventRecord,
  type PullFinishOptions,
  type RosterEntry,
  type TimingHttpClient,
  type TimingProviderAdapter,
  TimingProviderError,
  timingErrorForStatus,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.mylaps.com/v1';
const DEFAULT_TOKEN_URL = 'https://api.mylaps.com/oauth/token';
const TOKEN_SKEW_MS = 30_000; // refresh a little before expiry

export interface MyLapsOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  tokenUrl?: string;
  httpClient: TimingHttpClient;
  now?: () => Date;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const numOrUndef = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

export class MyLapsAdapter implements TimingProviderAdapter {
  readonly provider = 'mylaps' as const;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly http: TimingHttpClient;
  private readonly now: () => Date;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(opts: MyLapsOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.tokenUrl = opts.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.http = opts.httpClient;
    this.now = opts.now ?? (() => new Date());
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now().getTime() < this.tokenExpiresAt - TOKEN_SKEW_MS) {
      return this.token;
    }
    const res = await this.http(
      'POST',
      this.tokenUrl,
      { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      {
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      },
    );
    if (res.status !== 200) throw timingErrorForStatus(res.status, `mylaps token ${res.status}`);
    const body = (res.body ?? {}) as { access_token?: string; expires_in?: number };
    if (!body.access_token)
      throw new TimingProviderError('auth', 'mylaps token response missing access_token');
    this.token = body.access_token;
    this.tokenExpiresAt = this.now().getTime() + (body.expires_in ?? 3600) * 1000;
    return this.token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.accessToken()}`, accept: 'application/json' };
  }

  async pullRoster(eventId: string): Promise<RosterEntry[]> {
    const res = await this.http(
      'GET',
      `${this.baseUrl}/events/${eventId}/participants`,
      await this.authHeaders(),
    );
    if (res.status !== 200) throw timingErrorForStatus(res.status, `mylaps roster ${res.status}`);
    const body = (res.body ?? {}) as { participants?: unknown[] };
    const list = Array.isArray(body.participants) ? body.participants : [];
    const entries: RosterEntry[] = [];
    for (const raw of list) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const bib = str(p.race_number ?? p.bib);
      if (bib === '') continue;
      const entry: RosterEntry = {
        bib,
        firstName: str(p.first_name),
        lastName: str(p.last_name),
      };
      const transponder = str(p.transponder_id ?? p.chip_id);
      if (transponder) entry.transponderId = transponder;
      const email = str(p.email);
      if (email) entry.email = email.toLowerCase();
      entries.push(entry);
    }
    return entries;
  }

  async pullFinishEvents(
    eventId: string,
    opts: PullFinishOptions = {},
  ): Promise<FinishEventRecord[]> {
    const res = await this.http(
      'GET',
      `${this.baseUrl}/events/${eventId}/passings`,
      await this.authHeaders(),
    );
    if (res.status !== 200) throw timingErrorForStatus(res.status, `mylaps passings ${res.status}`);
    const body = (res.body ?? {}) as { passings?: unknown[] };
    const list = Array.isArray(body.passings) ? body.passings : [];
    const out: FinishEventRecord[] = [];
    for (const raw of list) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const bib = str(p.race_number ?? p.bib);
      if (bib === '') continue;
      const recordedAt = p.recorded_at ? new Date(str(p.recorded_at)) : new Date();
      if (opts.since && recordedAt < opts.since) continue;
      const lap = numOrUndef(p.lap_number) ?? 1;
      const rec: FinishEventRecord = {
        bib,
        splitName: `lap_${lap}`,
        recordedAt,
        raw: p,
      };
      const chip = numOrUndef(p.chip_time_ms);
      if (chip !== undefined) rec.chipTimeMs = chip;
      out.push(rec);
    }
    return out;
  }
}
