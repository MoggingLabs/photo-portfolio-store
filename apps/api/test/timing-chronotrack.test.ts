// F4.7 — ChronoTrack adapter tests (fixtures, no network).

import { describe, expect, it, vi } from 'vitest';

import { ChronoTrackAdapter, type TimingHttpClient } from '@pkg/integrations';

const make = (http: TimingHttpClient) =>
  new ChronoTrackAdapter({
    username: 'u',
    userToken: 't',
    httpClient: http,
    baseUrl: 'https://ct.test/api',
  });

describe('ChronoTrackAdapter.pullRoster', () => {
  it('sends HTTP Basic auth and paginates until a short page', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      entry_bib: String(i + 1),
      entry_first_name: 'A',
      entry_last_name: 'B',
      entry_email: `r${i}@x.io`,
    }));
    const http = vi.fn(async (_method: string, url: string) => {
      if (url.includes('page=1')) return { status: 200, body: { event_entry: page1 } };
      if (url.includes('page=2'))
        return {
          status: 200,
          body: { event_entry: [{ entry_bib: '51', entry_first_name: 'C', entry_last_name: 'D' }] },
        };
      return { status: 200, body: { event_entry: [] } };
    });
    const roster = await make(http).pullRoster('e1');
    expect(roster).toHaveLength(51);
    const [, , headers] = http.mock.calls[0] as [string, string, Record<string, string>];
    expect(headers.authorization).toBe(`Basic ${Buffer.from('u:t').toString('base64')}`);
    // stopped after the short second page (no third call).
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('maps auth errors to a typed error', async () => {
    await expect(
      make(vi.fn(async () => ({ status: 403, body: {} }))).pullRoster('e'),
    ).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('ChronoTrackAdapter.pullFinishEvents', () => {
  it('maps chip/gun ms and split name', async () => {
    const http = vi.fn(async () => ({
      status: 200,
      body: {
        results: [
          {
            results_bib: '5',
            results_split: 'finish',
            results_time_ms: 1195000,
            results_gun_time_ms: 1200000,
            results_time_recorded: '2026-06-01T10:00:00Z',
          },
        ],
      },
    }));
    const finishes = await make(http).pullFinishEvents('e1');
    expect(finishes[0]).toMatchObject({
      bib: '5',
      splitName: 'finish',
      chipTimeMs: 1195000,
      gunTimeMs: 1200000,
    });
  });
});
