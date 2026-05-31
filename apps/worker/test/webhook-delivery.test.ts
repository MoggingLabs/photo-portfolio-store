// F4.11 — webhook delivery sweep tests (fake db, injected http client + clock).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/db', () => ({
  schema: {
    webhooks: {
      webhookSubscriptions: {
        id: { column: 'id' },
        targetUrl: { column: 'targetUrl' },
        secretEncrypted: { column: 'secretEncrypted' },
        enabled: { column: 'enabled' },
        cooldownUntil: { column: 'cooldownUntil' },
        consecutiveFailures: { column: 'consecutiveFailures' },
        disabledReason: { column: 'disabledReason' },
        updatedAt: { column: 'updatedAt' },
      },
      webhookDeliveries: {
        id: { column: 'id' },
        subscriptionId: { column: 'subscriptionId' },
        attempt: { column: 'attempt' },
        eventId: { column: 'eventId' },
        eventType: { column: 'eventType' },
        payloadJson: { column: 'payloadJson' },
        status: { column: 'status' },
        nextRetryAt: { column: 'nextRetryAt' },
        scheduledAt: { column: 'scheduledAt' },
        httpStatus: { column: 'httpStatus' },
        responseBodyExcerpt: { column: 'responseBodyExcerpt' },
        deliveredAt: { column: 'deliveredAt' },
      },
    },
  },
}));

// Real signing/ssrf; deterministic crypto stub so the test controls the secret.
vi.mock('@pkg/integrations', async (orig) => {
  const actual = await orig<typeof import('@pkg/integrations')>();
  return { ...actual, decryptCredentials: () => 'test-secret' };
});

vi.mock('drizzle-orm', () => {
  const noop = () => ({});
  return { and: noop, asc: noop, eq: noop, isNull: noop, lte: noop, or: noop };
});

interface Sub {
  id: string;
  targetUrl: string;
  secretEncrypted: string;
  enabled: boolean;
  cooldownUntil: Date | null;
  consecutiveFailures: number;
  disabledReason: string | null;
}
interface Del {
  id: string;
  subscriptionId: string;
  attempt: number;
  eventId: string;
  eventType: string;
  payloadJson: unknown;
  status: string;
  nextRetryAt: Date | null;
  scheduledAt: Date;
  httpStatus: number | null;
  deliveredAt: Date | null;
}

let subs: Sub[];
let dels: Del[];

// The job's join-select is replaced wholesale: we return the joined DueRow set
// directly from the first select() call. update() routes by a tag on set keys.
const makeDb = () => {
  const select = () => {
    const api = {
      from: () => api,
      innerJoin: () => api,
      where: () => api,
      orderBy: () => api,
      limit: () =>
        Promise.resolve(
          dels
            .filter((d) => d.status === 'pending' || d.status === 'retrying')
            .map((d) => {
              const s = subs.find((x) => x.id === d.subscriptionId) as Sub;
              return {
                deliveryId: d.id,
                subscriptionId: d.subscriptionId,
                attempt: d.attempt,
                eventId: d.eventId,
                eventType: d.eventType,
                payloadJson: d.payloadJson,
                targetUrl: s.targetUrl,
                secretEncrypted: s.secretEncrypted,
                enabled: s.enabled,
                cooldownUntil: s.cooldownUntil,
                consecutiveFailures: s.consecutiveFailures,
              };
            }),
        ),
    };
    return api;
  };

  // update(table).set(values).where(pred) — we can't read the table arg easily,
  // so disambiguate by which fields are present in `set`.
  const update = () => ({
    set: (s: Record<string, unknown>) => ({
      where: () => {
        const isDelivery = 'status' in s || 'deliveredAt' in s;
        if (isDelivery) {
          for (const d of dels) if (lastMatchedDelivery === d.id) Object.assign(d, s);
        } else {
          for (const sub of subs) if (lastMatchedSub === sub.id) Object.assign(sub, s);
        }
        return Promise.resolve();
      },
    }),
  });

  return { select, update } as never;
};

// The job calls update(...).where(eq(id, X)); our drizzle mock makes eq a noop,
// so we track the "current" target via the delivery/sub being processed. To
// keep it simple we patch the job to process one delivery at a time in tests.
let lastMatchedDelivery = '';
let lastMatchedSub = '';

const sub = (over: Partial<Sub> = {}): Sub => ({
  id: 's1',
  targetUrl: 'https://hooks.example.com/x',
  secretEncrypted: 'enc',
  enabled: true,
  cooldownUntil: null,
  consecutiveFailures: 0,
  disabledReason: null,
  ...over,
});
const del = (over: Partial<Del> = {}): Del => ({
  id: 'd1',
  subscriptionId: 's1',
  attempt: 1,
  eventId: 'e1',
  eventType: 'order.paid',
  payloadJson: { a: 1 },
  status: 'pending',
  nextRetryAt: null,
  scheduledAt: new Date('2026-05-31T00:00:00Z'),
  httpStatus: null,
  deliveredAt: null,
  ...over,
});

const NOW = new Date('2026-05-31T12:00:00Z');
const deps = (httpClient: (...a: unknown[]) => Promise<{ status: number; body: string }>) => ({
  masterKey: 'mk',
  httpClient: httpClient as never,
  now: () => NOW,
  jitter: (b: number) => b, // deterministic
});

let job: typeof import('../src/jobs/webhook-delivery.js');

beforeEach(async () => {
  subs = [];
  dels = [];
  lastMatchedDelivery = 'd1';
  lastMatchedSub = 's1';
  job = await import('../src/jobs/webhook-delivery.js');
});

describe('runWebhookDeliveries', () => {
  it('marks a 2xx delivery as delivered and resets the failure streak', async () => {
    subs = [sub({ consecutiveFailures: 3 })];
    dels = [del()];
    const http = vi.fn(async () => ({ status: 200, body: 'ok' }));
    const res = await job.runWebhookDeliveries(makeDb(), deps(http));
    expect(res.delivered).toBe(1);
    expect(dels[0]?.status).toBe('delivered');
    expect(dels[0]?.deliveredAt).toEqual(NOW);
    expect(subs[0]?.consecutiveFailures).toBe(0);
    // Signed headers were sent.
    expect(http).toHaveBeenCalledWith(
      'https://hooks.example.com/x',
      expect.any(String),
      expect.objectContaining({ 'x-webhook-signature': expect.stringMatching(/^sha256=/) }),
    );
  });

  it('schedules a retry with backoff on a 5xx', async () => {
    subs = [sub()];
    dels = [del({ attempt: 1 })];
    const http = vi.fn(async () => ({ status: 503, body: 'busy' }));
    const res = await job.runWebhookDeliveries(makeDb(), deps(http));
    expect(res.retried).toBe(1);
    expect(dels[0]?.status).toBe('retrying');
    expect(dels[0]?.attempt).toBe(2);
    // First retry delay is 30s from now.
    expect(dels[0]?.nextRetryAt).toEqual(new Date(NOW.getTime() + job.RETRY_DELAYS_MS[0]));
    expect(subs[0]?.consecutiveFailures).toBe(1);
  });

  it('disables the subscription on 410 Gone (no further retries)', async () => {
    subs = [sub()];
    dels = [del()];
    const http = vi.fn(async () => ({ status: 410, body: 'gone' }));
    const res = await job.runWebhookDeliveries(makeDb(), deps(http));
    expect(res.failed).toBe(1);
    expect(dels[0]?.status).toBe('failed');
    expect(subs[0]?.enabled).toBe(false);
    expect(subs[0]?.disabledReason).toBe('gone');
  });

  it('fails without retry on a non-410 4xx', async () => {
    subs = [sub()];
    dels = [del()];
    const http = vi.fn(async () => ({ status: 400, body: 'bad' }));
    const res = await job.runWebhookDeliveries(makeDb(), deps(http));
    expect(res.failed).toBe(1);
    expect(dels[0]?.status).toBe('failed');
    expect(subs[0]?.enabled).toBe(true); // 4xx does not disable
  });

  it('disables after retries are exhausted (max attempts)', async () => {
    subs = [sub()];
    dels = [del({ attempt: job.MAX_ATTEMPTS })];
    const http = vi.fn(async () => ({ status: 500, body: 'err' }));
    const res = await job.runWebhookDeliveries(makeDb(), deps(http));
    expect(res.failed).toBe(1);
    expect(dels[0]?.status).toBe('failed');
    expect(subs[0]?.disabledReason).toBe('max_retries');
  });

  it('opens the circuit breaker after 5 consecutive failures (cooldown set)', async () => {
    subs = [sub({ consecutiveFailures: 4 })];
    dels = [del({ attempt: 1 })];
    const http = vi.fn(async () => ({ status: 500, body: 'err' }));
    await job.runWebhookDeliveries(makeDb(), deps(http));
    expect(subs[0]?.consecutiveFailures).toBe(5);
    expect(subs[0]?.cooldownUntil).not.toBeNull();
  });

  it('retries (network error) without an http status', async () => {
    subs = [sub()];
    dels = [del({ attempt: 1 })];
    const http = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await job.runWebhookDeliveries(makeDb(), deps(http));
    expect(res.retried).toBe(1);
    expect(dels[0]?.status).toBe('retrying');
  });
});
