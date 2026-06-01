// F4.12 — notification send sweep tests (fake db, injected senders).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/db', () => ({
  schema: {
    notifications: {
      participantNotifications: {
        id: { column: 'id' },
        channel: { column: 'channel' },
        template: { column: 'template' },
        payloadJson: { column: 'payloadJson' },
        status: { column: 'status' },
      },
    },
  },
}));

vi.mock('drizzle-orm', () => ({ eq: () => ({}), inArray: () => ({}) }));

type Row = Record<string, unknown>;
let rows: Row[];

const makeDb = () => ({
  select: () => {
    const api = {
      from: () => api,
      where: () => api,
      limit: () => Promise.resolve(rows.filter((r) => r.status === 'pending')),
    };
    return api;
  },
  update: () => ({
    set: (s: Row) => ({
      where: () => {
        // single in-flight row tracked by currentId
        const r = rows.find((x) => x.id === currentId);
        if (r) Object.assign(r, s);
        return Promise.resolve();
      },
    }),
  }),
});
let currentId = '';

let job: typeof import('../src/jobs/notifications-send.js');
const NOON = new Date('2026-06-01T14:00:00Z'); // 14:00 UTC -> daytime for en-GB
const NIGHT = new Date('2026-06-01T02:00:00Z');

const payload = (over: Row = {}) => ({
  email: 'a@x.io',
  phone: '+15551234',
  locale: 'en-GB',
  eventId: 'e1',
  eventName: 'Marathon',
  participantId: 'p1',
  matchedPhotos: 3,
  ...over,
});

const deps = (over: Record<string, unknown> = {}) => ({
  galleryTokenSecret: 'sec',
  appBaseUrl: 'https://app.test',
  emailSender: vi.fn(async () => ({ messageId: 'em1' })),
  now: () => NOON,
  ...over,
});

beforeEach(async () => {
  rows = [];
  job = await import('../src/jobs/notifications-send.js');
});

describe('runNotificationSend', () => {
  it('sends a pending email with a signed gallery link and marks it sent', async () => {
    rows = [
      {
        id: 'n1',
        channel: 'email',
        template: 'photos_ready',
        payloadJson: payload(),
        status: 'pending',
      },
    ];
    currentId = 'n1';
    const d = deps();
    const res = await job.runNotificationSend(makeDb() as never, d as never);
    expect(res.sent).toBe(1);
    expect(rows[0]?.status).toBe('sent');
    expect(rows[0]?.providerMessageId).toBe('em1');
    const arg = (d.emailSender as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      html: string;
      to: string;
    };
    expect(arg.to).toBe('a@x.io');
    expect(arg.html).toContain('https://app.test/g/');
  });

  it('defers an SMS during quiet hours (leaves it pending)', async () => {
    rows = [
      {
        id: 'n1',
        channel: 'sms',
        template: 'photos_ready',
        payloadJson: payload(),
        status: 'pending',
      },
    ];
    currentId = 'n1';
    const res = await job.runNotificationSend(
      makeDb() as never,
      deps({ now: () => NIGHT, smsSender: vi.fn(async () => ({ messageId: 's1' })) }) as never,
    );
    expect(res.deferred).toBe(1);
    expect(rows[0]?.status).toBe('pending');
  });

  it('sends an SMS outside quiet hours when a sender is configured', async () => {
    rows = [
      {
        id: 'n1',
        channel: 'sms',
        template: 'photos_ready',
        payloadJson: payload(),
        status: 'pending',
      },
    ];
    currentId = 'n1';
    const smsSender = vi.fn(async () => ({ messageId: 's1' }));
    const res = await job.runNotificationSend(makeDb() as never, deps({ smsSender }) as never);
    expect(res.sent).toBe(1);
    expect(rows[0]?.status).toBe('sent');
    expect(smsSender).toHaveBeenCalled();
  });

  it('skips SMS as unconfigured when no sms sender is provided', async () => {
    rows = [
      {
        id: 'n1',
        channel: 'sms',
        template: 'photos_ready',
        payloadJson: payload(),
        status: 'pending',
      },
    ];
    currentId = 'n1';
    const res = await job.runNotificationSend(makeDb() as never, deps() as never);
    expect(res.skipped).toBe(1);
    expect(rows[0]?.status).toBe('skipped');
    expect(rows[0]?.lastError).toBe('sms_not_configured');
  });

  it('marks an email failed when the sender throws', async () => {
    rows = [
      {
        id: 'n1',
        channel: 'email',
        template: 'photos_ready',
        payloadJson: payload(),
        status: 'pending',
      },
    ];
    currentId = 'n1';
    const res = await job.runNotificationSend(
      makeDb() as never,
      deps({
        emailSender: vi.fn(async () => {
          throw new Error('smtp down');
        }),
      }) as never,
    );
    expect(res.failed).toBe(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.lastError).toBe('smtp down');
  });
});
