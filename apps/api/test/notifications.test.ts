// F4.12 — notification selection + enqueue service tests (fake in-memory db).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const cols = (...names: string[]) => Object.fromEntries(names.map((n) => [n, { column: n }]));

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    participants: {
      participants: cols('id', 'eventId', 'bib', 'email', 'phone', 'smsOptIn', 'locale'),
    },
    timing: { finishEvents: cols('eventId', 'bib') },
    search: { bibTags: cols('eventId', 'bibNumber', 'photoId', 'confidence') },
    notifications: {
      participantNotifications: cols(
        'id',
        'participantId',
        'eventId',
        'channel',
        'template',
        'status',
        'dispatchWindowStart',
        'sentAt',
        'createdAt',
      ),
      notificationSuppressions: cols('channel', 'address'),
    },
    events: { events: cols('id', 'name') },
  },
}));

vi.mock('drizzle-orm', () => {
  type F = { column: string };
  const isF = (v: unknown): v is F => typeof v === 'object' && v !== null && 'column' in (v as F);
  const val = (v: unknown, r: Record<string, unknown>) => (isF(v) ? r[v.column] : v);
  return {
    and:
      (...p: Array<(r: Record<string, unknown>) => boolean>) =>
      (r: Record<string, unknown>) =>
        p.every((f) => f(r)),
    eq: (a: unknown, b: unknown) => (r: Record<string, unknown>) => val(a, r) === val(b, r),
    gte: (a: unknown, b: unknown) => (r: Record<string, unknown>) => Number(val(a, r)) >= Number(b),
    inArray: (a: unknown, list: unknown[]) => (r: Record<string, unknown>) =>
      list.includes(val(a, r)),
  };
});

type Row = Record<string, unknown>;
interface Store {
  participants: Row[];
  finishEvents: Row[];
  bibTags: Row[];
  participantNotifications: Row[];
  notificationSuppressions: Row[];
  events: Row[];
}
let store: Store;

const makeDb = () => {
  const select = (sel: Record<string, { column: string }>) => {
    const filters: Array<(r: Row) => boolean> = [];
    let bucket: Row[] = [];
    const api = {
      from: (t: { __b?: keyof Store }) => {
        bucket = t.__b ? store[t.__b] : [];
        return api;
      },
      where: (p: (r: Row) => boolean) => {
        filters.push(p);
        return api;
      },
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
  const insert = () => ({
    values: (v: Row) => ({
      onConflictDoNothing: () => ({
        returning: () => {
          const dupe = store.participantNotifications.some(
            (r) =>
              r.participantId === v.participantId &&
              r.eventId === v.eventId &&
              r.channel === v.channel &&
              (r.dispatchWindowStart as Date)?.getTime?.() ===
                (v.dispatchWindowStart as Date)?.getTime?.(),
          );
          if (dupe) return Promise.resolve([]);
          const id = `n${store.participantNotifications.length + 1}`;
          store.participantNotifications.push({
            createdAt: new Date('2026-06-01T00:00:00Z'),
            ...v,
            id,
          });
          return Promise.resolve([{ id }]);
        },
      }),
    }),
  });
  return { select, insert } as never;
};

let svc: typeof import('../src/services/notifications.js');

beforeEach(async () => {
  store = {
    participants: [],
    finishEvents: [],
    bibTags: [],
    participantNotifications: [],
    notificationSuppressions: [],
    events: [{ id: 'e1', name: 'Marathon' }],
  };
  const { schema } = await import('@pkg/db');
  (schema.participants.participants as { __b?: string }).__b = 'participants';
  (schema.timing.finishEvents as { __b?: string }).__b = 'finishEvents';
  (schema.search.bibTags as { __b?: string }).__b = 'bibTags';
  (schema.notifications.participantNotifications as { __b?: string }).__b =
    'participantNotifications';
  (schema.notifications.notificationSuppressions as { __b?: string }).__b =
    'notificationSuppressions';
  (schema.events.events as { __b?: string }).__b = 'events';
  svc = await import('../src/services/notifications.js');
});

const seedMatch = (over: Partial<Row> = {}) => {
  store.participants.push({
    id: 'p1',
    eventId: 'e1',
    bib: '101',
    email: 'a@x.io',
    phone: null,
    smsOptIn: false,
    locale: null,
    ...over,
  });
  store.finishEvents.push({ eventId: 'e1', bib: '101' });
  store.bibTags.push({ eventId: 'e1', bibNumber: '101', photoId: 'ph1', confidence: '0.95' });
};

const NOW = new Date('2026-06-01T12:00:00Z');

describe('selectNotifiable', () => {
  it('selects a participant with a finish event AND a confident bib match', async () => {
    seedMatch();
    const r = await svc.selectNotifiable(makeDb(), 'e1');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ participantId: 'p1', matchedPhotos: 1 });
  });

  it('excludes participants without a finish event', async () => {
    seedMatch();
    store.finishEvents = [];
    expect(await svc.selectNotifiable(makeDb(), 'e1')).toHaveLength(0);
  });

  it('excludes low-confidence-only matches', async () => {
    seedMatch();
    store.bibTags = [{ eventId: 'e1', bibNumber: '101', photoId: 'ph1', confidence: '0.40' }];
    expect(await svc.selectNotifiable(makeDb(), 'e1')).toHaveLength(0);
  });
});

describe('enqueueForEvent', () => {
  it('enqueues one email (photos_ready) and is idempotent within a window', async () => {
    seedMatch();
    const db = makeDb();
    const r1 = await svc.enqueueForEvent(db, 'e1', { now: NOW });
    expect(r1.enqueued).toBe(1);
    expect(store.participantNotifications[0]?.template).toBe('photos_ready');
    // Same window -> no duplicate.
    const r2 = await svc.enqueueForEvent(db, 'e1', { now: NOW });
    expect(r2.enqueued).toBe(0);
    expect(store.participantNotifications).toHaveLength(1);
  });

  it('uses photos_more_added template once a prior email exists', async () => {
    seedMatch();
    const db = makeDb();
    await svc.enqueueForEvent(db, 'e1', { now: NOW });
    const later = new Date(NOW.getTime() + 31 * 60 * 1000);
    await svc.enqueueForEvent(db, 'e1', { now: later });
    expect(store.participantNotifications).toHaveLength(2);
    expect(store.participantNotifications[1]?.template).toBe('photos_more_added');
  });

  it('skips a participant without an email (no row written)', async () => {
    seedMatch({ email: null });
    const r = await svc.enqueueForEvent(makeDb(), 'e1', { now: NOW });
    expect(r.skipped).toBe(1);
    expect(store.participantNotifications).toHaveLength(0);
  });

  it('marks a suppressed email as suppressed, never pending', async () => {
    seedMatch();
    store.notificationSuppressions.push({ channel: 'email', address: 'a@x.io' });
    const r = await svc.enqueueForEvent(makeDb(), 'e1', { now: NOW });
    expect(r.suppressed).toBe(1);
    expect(store.participantNotifications[0]?.status).toBe('suppressed');
  });

  it('also enqueues an SMS row when opted in with a phone', async () => {
    seedMatch({ smsOptIn: true, phone: '+15551234' });
    await svc.enqueueForEvent(makeDb(), 'e1', { now: NOW });
    const channels = store.participantNotifications.map((n) => n.channel).sort();
    expect(channels).toEqual(['email', 'sms']);
  });
});
