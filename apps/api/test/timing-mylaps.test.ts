// F4.8 — MyLaps adapter tests (OAuth token + multi-lap, fixtures).

import { describe, expect, it, vi } from 'vitest';

import { MyLapsAdapter, type TimingHttpClient } from '@pkg/integrations';

const tokenResponse = { status: 200, body: { access_token: 'tok', expires_in: 3600 } };

const make = (http: TimingHttpClient, now = () => new Date('2026-06-01T12:00:00Z')) =>
  new MyLapsAdapter({
    clientId: 'cid',
    clientSecret: 'sec',
    httpClient: http,
    baseUrl: 'https://ml.test/v1',
    tokenUrl: 'https://ml.test/oauth/token',
    now,
  });

describe('MyLapsAdapter OAuth', () => {
  it('exchanges client credentials for a token and bearer-auths data calls', async () => {
    const http = vi.fn(async (method: string, url: string) => {
      if (url.includes('/oauth/token')) return tokenResponse;
      return {
        status: 200,
        body: {
          participants: [
            { race_number: '12', first_name: 'A', last_name: 'B', transponder_id: 'TR-9' },
          ],
        },
      };
    });
    const roster = await make(http as never).pullRoster('e1');
    expect(roster[0]).toMatchObject({ bib: '12', transponderId: 'TR-9' });
    // First call is the token POST...
    const [m0, u0, h0, b0] = http.mock.calls[0] as [
      string,
      string,
      Record<string, string>,
      unknown,
    ];
    expect(m0).toBe('POST');
    expect(u0).toContain('/oauth/token');
    expect(h0['content-type']).toContain('x-www-form-urlencoded');
    expect(b0).toMatchObject({ grant_type: 'client_credentials', client_id: 'cid' });
    // ...then the GET carries the bearer token.
    const [, , h1] = http.mock.calls[1] as [string, string, Record<string, string>];
    expect(h1.authorization).toBe('Bearer tok');
  });

  it('caches the token across calls (one token exchange for two pulls)', async () => {
    const http = vi.fn(async (_m: string, url: string) => {
      if (url.includes('/oauth/token')) return tokenResponse;
      if (url.includes('participants')) return { status: 200, body: { participants: [] } };
      return { status: 200, body: { passings: [] } };
    });
    const a = make(http as never);
    await a.pullRoster('e1');
    await a.pullFinishEvents('e1');
    const tokenCalls = http.mock.calls.filter((c) => String(c[1]).includes('/oauth/token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('throws auth when the token response has no access_token', async () => {
    const http = vi.fn(async () => ({ status: 200, body: {} }));
    await expect(make(http as never).pullRoster('e1')).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('MyLapsAdapter multi-lap passings', () => {
  it('records each passing as a distinct lap_N finish event', async () => {
    const http = vi.fn(async (_m: string, url: string) => {
      if (url.includes('/oauth/token')) return tokenResponse;
      return {
        status: 200,
        body: {
          passings: [
            {
              race_number: '7',
              lap_number: 1,
              chip_time_ms: 60000,
              recorded_at: '2026-06-01T10:00:00Z',
            },
            {
              race_number: '7',
              lap_number: 2,
              chip_time_ms: 125000,
              recorded_at: '2026-06-01T10:02:05Z',
            },
          ],
        },
      };
    });
    const finishes = await make(http as never).pullFinishEvents('e1');
    expect(finishes.map((f) => f.splitName)).toEqual(['lap_1', 'lap_2']);
    expect(finishes[1]?.chipTimeMs).toBe(125000);
  });

  it('maps a 401 to a typed auth error', async () => {
    const http = vi.fn(async (_m: string, url: string) =>
      url.includes('/oauth/token') ? tokenResponse : { status: 401, body: {} },
    );
    await expect(make(http as never).pullFinishEvents('e1')).rejects.toMatchObject({
      code: 'auth',
    });
  });
});
