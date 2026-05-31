// F4.11 — webhooks API service tests (fake db, real crypto).

import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    webhooks: {
      webhookSubscriptions: {
        id: { column: 'id' },
        orgId: { column: 'orgId' },
        targetUrl: { column: 'targetUrl' },
        secretEncrypted: { column: 'secretEncrypted' },
        eventTypes: { column: 'eventTypes' },
        enabled: { column: 'enabled' },
        disabledReason: { column: 'disabledReason' },
        createdAt: { column: 'createdAt' },
        updatedAt: { column: 'updatedAt' },
      },
      webhookDeliveries: {
        id: { column: 'id' },
        subscriptionId: { column: 'subscriptionId' },
        eventId: { column: 'eventId' },
        eventType: { column: 'eventType' },
        attempt: { column: 'attempt' },
        status: { column: 'status' },
        httpStatus: { column: 'httpStatus' },
        scheduledAt: { column: 'scheduledAt' },
        deliveredAt: { column: 'deliveredAt' },
        nextRetryAt: { column: 'nextRetryAt' },
        payloadJson: { column: 'payloadJson' },
      },
    },
  },
}));

vi.mock('drizzle-orm', () => {
  type F = { column: string };
  const isF = (v: unknown): v is F => typeof v === 'object' && v !== null && 'column' in (v as F);
  const val = (v: unknown, row: Record<string, unknown>) => (isF(v) ? row[v.column] : v);
  return {
    and:
      (...p: Array<(r: Record<string, unknown>) => boolean>) =>
      (r: Record<string, unknown>) =>
        p.every((f) => f(r)),
    eq: (a: unknown, b: unknown) => (r: Record<string, unknown>) => val(a, r) === val(b, r),
    desc: (c: unknown) => ({ desc: c }),
  };
});

type Row = Record<string, unknown>;
let subs: Row[];
let dels: Row[];
let seq: number;

const makeDb = () => {
  const select = (sel: Record<string, { column: string }>) => {
    const filters: Array<(r: Row) => boolean> = [];
    let bucket: Row[] = [];
    const api = {
      from: (t: { __b?: string }) => {
        bucket = t.__b === 'dels' ? dels : subs;
        return api;
      },
      where: (p: (r: Row) => boolean) => {
        filters.push(p);
        return api;
      },
      orderBy: () => api,
      limit: () => Promise.resolve(project()),
      then: (resolve: (v: Row[]) => unknown) => resolve(project()),
    };
    const project = () =>
      bucket
        .filter((r) => filters.every((f) => f(r)))
        .map((r) => {
          const o: Row = {};
          for (const [a, ref] of Object.entries(sel)) o[a] = r[ref.column];
          return o;
        });
    return api;
  };

  const insert = (t: { __b?: string }) => ({
    values: (v: Row | Row[]) => {
      const bucket = t.__b === 'dels' ? dels : subs;
      const list = Array.isArray(v) ? v : [v];
      const stored = list.map((vv) => {
        const id = `id${seq++}`;
        const row: Row = { createdAt: new Date('2026-05-31T00:00:00Z'), ...vv, id };
        bucket.push(row);
        return row;
      });
      const ret = Promise.resolve(stored.map((r) => ({ id: r.id })));
      return Object.assign(ret, {
        returning: (sel?: Record<string, { column: string }>) =>
          Promise.resolve(
            stored.map((r) => {
              if (!sel) return r;
              const o: Row = {};
              for (const [a, ref] of Object.entries(sel)) o[a] = r[ref.column];
              return o;
            }),
          ),
      });
    },
  });

  const update = (t: { __b?: string }) => ({
    set: (s: Row) => ({
      where: (p: (r: Row) => boolean) => {
        const bucket = t.__b === 'dels' ? dels : subs;
        for (const r of bucket) if (p(r)) Object.assign(r, s);
        return Promise.resolve();
      },
    }),
  });

  return { select, insert, update } as never;
};

const masterKey = randomBytes(32).toString('base64');
let svc: typeof import('../src/services/webhooks.js');

beforeEach(async () => {
  subs = [];
  dels = [];
  seq = 1;
  const { schema } = await import('@pkg/db');
  (schema.webhooks.webhookSubscriptions as { __b?: string }).__b = 'subs';
  (schema.webhooks.webhookDeliveries as { __b?: string }).__b = 'dels';
  svc = await import('../src/services/webhooks.js');
});

describe('createSubscription', () => {
  it('encrypts the secret, returns it once, and stores no plaintext', async () => {
    const db = makeDb();
    const { subscription, secret } = await svc.createSubscription(
      db,
      'org1',
      { targetUrl: 'https://hooks.example.com/x', eventTypes: ['order.paid', 'order.paid'] },
      { masterKey },
    );
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(subscription.eventTypes).toEqual(['order.paid']); // deduped
    expect(JSON.stringify(subscription)).not.toContain(secret);
    expect(String(subs[0]?.secretEncrypted)).not.toContain(secret);
  });

  it('rejects an SSRF / non-https target url', async () => {
    const db = makeDb();
    await expect(
      svc.createSubscription(
        db,
        'org1',
        { targetUrl: 'https://169.254.169.254/x', eventTypes: ['order.paid'] },
        { masterKey },
      ),
    ).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('rejects unknown event types', async () => {
    const db = makeDb();
    await expect(
      svc.createSubscription(
        db,
        'org1',
        { targetUrl: 'https://x.io', eventTypes: ['bogus.event'] },
        { masterKey },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('deleteSubscription', () => {
  it('soft-disables with a reason', async () => {
    const db = makeDb();
    const { subscription } = await svc.createSubscription(
      db,
      'org1',
      { targetUrl: 'https://x.io', eventTypes: ['order.paid'] },
      { masterKey },
    );
    await svc.deleteSubscription(db, 'org1', subscription.id);
    expect(subs[0]?.enabled).toBe(false);
    expect(subs[0]?.disabledReason).toBe('deleted');
  });
});

describe('enqueueEvent', () => {
  it('writes one pending delivery per matching enabled subscription', async () => {
    const db = makeDb();
    await svc.createSubscription(
      db,
      'org1',
      { targetUrl: 'https://a.io', eventTypes: ['order.paid'] },
      { masterKey },
    );
    await svc.createSubscription(
      db,
      'org1',
      { targetUrl: 'https://b.io', eventTypes: ['event.published'] },
      { masterKey },
    );
    const { enqueued } = await svc.enqueueEvent(db, 'org1', 'order.paid', { orderId: 'o1' });
    expect(enqueued).toBe(1);
    expect(dels).toHaveLength(1);
    expect(dels[0]?.status).toBe('pending');
  });

  it('enqueues nothing when no subscription matches', async () => {
    const db = makeDb();
    const { enqueued } = await svc.enqueueEvent(db, 'org1', 'order.paid', {});
    expect(enqueued).toBe(0);
  });
});

describe('testSubscription', () => {
  it('queues a synthetic webhook.test delivery', async () => {
    const db = makeDb();
    const { subscription } = await svc.createSubscription(
      db,
      'org1',
      { targetUrl: 'https://x.io', eventTypes: ['order.paid'] },
      { masterKey },
    );
    const { eventId } = await svc.testSubscription(db, 'org1', subscription.id);
    expect(eventId).toBeTruthy();
    expect(dels[0]?.eventType).toBe('webhook.test');
  });

  it("throws not_found for someone else's subscription", async () => {
    const db = makeDb();
    const { subscription } = await svc.createSubscription(
      db,
      'org1',
      { targetUrl: 'https://x.io', eventTypes: ['order.paid'] },
      { masterKey },
    );
    await expect(svc.testSubscription(db, 'org2', subscription.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
