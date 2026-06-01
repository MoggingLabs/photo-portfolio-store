// F4.6 — RunSignup adapter + clock parsing tests (fixtures, no network).

import { describe, expect, it, vi } from 'vitest';

import {
  RunSignupAdapter,
  type TimingHttpClient,
  TimingProviderError,
  parseClockToMs,
} from '@pkg/integrations';

const make = (http: TimingHttpClient) =>
  new RunSignupAdapter({ apiKey: 'k', httpClient: http, baseUrl: 'https://rsu.test/Rest' });

describe('parseClockToMs', () => {
  it('parses HH:MM:SS(.mmm)', () => {
    expect(parseClockToMs('01:02:03')).toBe(3723000);
    expect(parseClockToMs('00:00:30.5')).toBe(30500);
    expect(parseClockToMs('45:10')).toBe(2710000);
  });
  it('returns undefined for blank/garbage', () => {
    expect(parseClockToMs('')).toBeUndefined();
    expect(parseClockToMs('abc')).toBeUndefined();
    expect(parseClockToMs(null)).toBeUndefined();
  });
});

describe('RunSignupAdapter.pullRoster', () => {
  it('maps participants and forwards the API key header', async () => {
    const http = vi.fn(async () => ({
      status: 200,
      body: {
        participants: [
          {
            bib_num: '101',
            age: '30',
            division: 'M30-34',
            user: { first_name: 'Ada', last_name: 'L', email: 'ADA@X.IO', gender: 'F' },
          },
          { bib_num: '', user: { first_name: 'No', last_name: 'Bib' } }, // skipped
        ],
      },
    }));
    const roster = await make(http).pullRoster('race1');
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      bib: '101',
      firstName: 'Ada',
      email: 'ada@x.io',
      age: 30,
      division: 'M30-34',
    });
    const [, headers] = http.mock.calls[0] as [string, Record<string, string>];
    expect(headers['X-RSU-API-KEY']).toBe('k');
  });

  it('maps auth/rate-limit/server errors to typed TimingProviderError', async () => {
    await expect(
      make(vi.fn(async () => ({ status: 401, body: {} }))).pullRoster('r'),
    ).rejects.toMatchObject({ code: 'auth' });
    await expect(
      make(vi.fn(async () => ({ status: 429, body: {} }))).pullRoster('r'),
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
    await expect(
      make(vi.fn(async () => ({ status: 503, body: {} }))).pullRoster('r'),
    ).rejects.toMatchObject({ code: 'transient', retryable: true });
  });
});

describe('RunSignupAdapter.pullFinishEvents', () => {
  it('maps results to finish records with gun/chip ms', async () => {
    const http = vi.fn(async () => ({
      status: 200,
      body: {
        results: [
          {
            bib_num: '101',
            split_name: 'finish',
            gun_time: '00:20:00',
            chip_time: '00:19:55',
            recorded_at: '2026-06-01T10:00:00Z',
          },
        ],
      },
    }));
    const finishes = await make(http).pullFinishEvents('race1');
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      bib: '101',
      splitName: 'finish',
      gunTimeMs: 1200000,
      chipTimeMs: 1195000,
    });
    expect(finishes[0]?.recordedAt).toEqual(new Date('2026-06-01T10:00:00Z'));
  });

  it('filters out events before the since cursor', async () => {
    const http = vi.fn(async () => ({
      status: 200,
      body: {
        results: [
          { bib_num: '1', recorded_at: '2026-06-01T09:00:00Z' },
          { bib_num: '2', recorded_at: '2026-06-01T11:00:00Z' },
        ],
      },
    }));
    const finishes = await make(http).pullFinishEvents('r', {
      since: new Date('2026-06-01T10:00:00Z'),
    });
    expect(finishes.map((f) => f.bib)).toEqual(['2']);
  });

  it('throws TimingProviderError on a non-200', async () => {
    await expect(
      make(vi.fn(async () => ({ status: 500, body: {} }))).pullFinishEvents('r'),
    ).rejects.toBeInstanceOf(TimingProviderError);
  });
});
