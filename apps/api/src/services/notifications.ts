// F4.12 — "photos are ready" notification selection + enqueue (API side).
//
// A participant is notifiable when they have a finish event AND at least one
// confidently bib-matched photo. Enqueue writes pending participant_notifications
// rows (one per 30-minute digest window — the unique index makes it idempotent
// and caps frequency). The payload snapshots everything the worker needs to
// send (email/phone/locale/event name/match count + gallery deep-link inputs)
// so the send sweep needs no joins. Suppressed addresses are recorded as
// 'suppressed', never sent. Participants without an email are skipped.

import { type DbClient, schema } from '@pkg/db';
import { and, eq, gte, inArray } from 'drizzle-orm';

const { participants } = schema.participants;
const { finishEvents } = schema.timing;
const { bibTags } = schema.search;
const { participantNotifications, notificationSuppressions } = schema.notifications;
const { events } = schema.events;

export const DIGEST_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_BIB_CONFIDENCE = 0.7;

export const windowStart = (now: Date): Date =>
  new Date(Math.floor(now.getTime() / DIGEST_WINDOW_MS) * DIGEST_WINDOW_MS);

export interface NotifiableParticipant {
  participantId: string;
  bib: string;
  email: string | null;
  phone: string | null;
  smsOptIn: boolean;
  locale: string | null;
  matchedPhotos: number;
}

export interface SelectOptions {
  confidenceThreshold?: number;
}

// Multi-query selection (join-free so it is straightforward to reason about and
// test): participants with a finish event AND >=1 confident bib match.
export const selectNotifiable = async (
  db: DbClient,
  eventId: string,
  opts: SelectOptions = {},
): Promise<NotifiableParticipant[]> => {
  const threshold = opts.confidenceThreshold ?? DEFAULT_BIB_CONFIDENCE;

  const roster = await db
    .select({
      id: participants.id,
      bib: participants.bib,
      email: participants.email,
      phone: participants.phone,
      smsOptIn: participants.smsOptIn,
      locale: participants.locale,
    })
    .from(participants)
    .where(eq(participants.eventId, eventId));
  if (roster.length === 0) return [];

  const finished = await db
    .select({ bib: finishEvents.bib })
    .from(finishEvents)
    .where(eq(finishEvents.eventId, eventId));
  const finishedBibs = new Set(finished.map((f) => f.bib));

  const tags = await db
    .select({ bib: bibTags.bibNumber, photoId: bibTags.photoId })
    .from(bibTags)
    .where(and(eq(bibTags.eventId, eventId), gte(bibTags.confidence, String(threshold))));
  const photosByBib = new Map<string, Set<string>>();
  for (const t of tags) {
    const set = photosByBib.get(t.bib) ?? new Set<string>();
    set.add(t.photoId);
    photosByBib.set(t.bib, set);
  }

  const out: NotifiableParticipant[] = [];
  for (const p of roster) {
    if (!finishedBibs.has(p.bib)) continue;
    const matched = photosByBib.get(p.bib)?.size ?? 0;
    if (matched < 1) continue;
    out.push({
      participantId: p.id,
      bib: p.bib,
      email: p.email,
      phone: p.phone,
      smsOptIn: p.smsOptIn,
      locale: p.locale,
      matchedPhotos: matched,
    });
  }
  return out;
};

export interface EnqueueResult {
  enqueued: number;
  skipped: number;
  suppressed: number;
}

interface EnqueueCtx {
  eventId: string;
  eventName: string;
  now: Date;
}

const loadSuppressed = async (
  db: DbClient,
  channel: 'email' | 'sms',
  addresses: string[],
): Promise<Set<string>> => {
  if (addresses.length === 0) return new Set();
  const rows = await db
    .select({ address: notificationSuppressions.address })
    .from(notificationSuppressions)
    .where(
      and(
        eq(notificationSuppressions.channel, channel),
        inArray(notificationSuppressions.address, addresses),
      ),
    );
  return new Set(rows.map((r) => r.address));
};

const priorEmailExists = async (
  db: DbClient,
  participantId: string,
  eventId: string,
): Promise<boolean> => {
  const rows = await db
    .select({ id: participantNotifications.id })
    .from(participantNotifications)
    .where(
      and(
        eq(participantNotifications.participantId, participantId),
        eq(participantNotifications.eventId, eventId),
        eq(participantNotifications.channel, 'email'),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

const insertRow = async (
  db: DbClient,
  row: {
    participantId: string;
    eventId: string;
    channel: 'email' | 'sms';
    template: string;
    status: 'pending' | 'suppressed';
    dispatchWindowStart: Date;
    payload: Record<string, unknown>;
  },
): Promise<boolean> => {
  const inserted = await db
    .insert(participantNotifications)
    .values({
      participantId: row.participantId,
      eventId: row.eventId,
      channel: row.channel,
      template: row.template,
      status: row.status,
      dispatchWindowStart: row.dispatchWindowStart,
      payloadJson: row.payload,
    })
    .onConflictDoNothing({
      target: [
        participantNotifications.participantId,
        participantNotifications.eventId,
        participantNotifications.channel,
        participantNotifications.dispatchWindowStart,
      ],
    })
    .returning({ id: participantNotifications.id });
  return inserted.length > 0;
};

const enqueueOne = async (
  db: DbClient,
  p: NotifiableParticipant,
  ctx: EnqueueCtx,
  emailSuppressed: Set<string>,
  smsSuppressed: Set<string>,
  result: EnqueueResult,
): Promise<void> => {
  if (!p.email) {
    result.skipped += 1; // no email -> skip (logged by caller); no row
    return;
  }
  const win = windowStart(ctx.now);
  const hadPrior = await priorEmailExists(db, p.participantId, ctx.eventId);
  const template = hadPrior ? 'photos_more_added' : 'photos_ready';
  const payload = {
    email: p.email,
    phone: p.phone,
    locale: p.locale,
    eventId: ctx.eventId,
    eventName: ctx.eventName,
    participantId: p.participantId,
    matchedPhotos: p.matchedPhotos,
  };

  const emailIsSuppressed = emailSuppressed.has(p.email);
  const wrote = await insertRow(db, {
    participantId: p.participantId,
    eventId: ctx.eventId,
    channel: 'email',
    template,
    status: emailIsSuppressed ? 'suppressed' : 'pending',
    dispatchWindowStart: win,
    payload,
  });
  if (wrote) {
    if (emailIsSuppressed) result.suppressed += 1;
    else result.enqueued += 1;
  }

  if (p.smsOptIn && p.phone && !smsSuppressed.has(p.phone)) {
    await insertRow(db, {
      participantId: p.participantId,
      eventId: ctx.eventId,
      channel: 'sms',
      template,
      status: 'pending',
      dispatchWindowStart: win,
      payload,
    });
  }
};

const loadEventName = async (db: DbClient, eventId: string): Promise<string | null> => {
  const rows = await db
    .select({ name: events.name })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return rows[0]?.name ?? null;
};

export const enqueueForEvent = async (
  db: DbClient,
  eventId: string,
  opts: { now?: Date; confidenceThreshold?: number } = {},
): Promise<EnqueueResult> => {
  const now = opts.now ?? new Date();
  const result: EnqueueResult = { enqueued: 0, skipped: 0, suppressed: 0 };
  const candidates = await selectNotifiable(db, eventId, opts);
  if (candidates.length === 0) return result;

  const eventName = (await loadEventName(db, eventId)) ?? 'your event';
  const emails = candidates.map((c) => c.email).filter((e): e is string => !!e);
  const phones = candidates.map((c) => c.phone).filter((p): p is string => !!p);
  const emailSuppressed = await loadSuppressed(db, 'email', emails);
  const smsSuppressed = await loadSuppressed(db, 'sms', phones);

  const ctx: EnqueueCtx = { eventId, eventName, now };
  for (const p of candidates) {
    await enqueueOne(db, p, ctx, emailSuppressed, smsSuppressed, result);
  }
  return result;
};

export interface EnqueueActiveResult extends EnqueueResult {
  events: number;
}

// Enqueue for every event that has finish events (the automatic dispatch path,
// triggered by the internal cron endpoint).
export const enqueueActive = async (
  db: DbClient,
  opts: { now?: Date; limit?: number; confidenceThreshold?: number } = {},
): Promise<EnqueueActiveResult> => {
  const rows = await db.select({ eventId: finishEvents.eventId }).from(finishEvents);
  const eventIds = [...new Set(rows.map((r) => r.eventId))].slice(0, opts.limit ?? 200);
  const totals: EnqueueActiveResult = { enqueued: 0, skipped: 0, suppressed: 0, events: 0 };
  for (const id of eventIds) {
    const r = await enqueueForEvent(db, id, opts);
    totals.enqueued += r.enqueued;
    totals.skipped += r.skipped;
    totals.suppressed += r.suppressed;
    totals.events += 1;
  }
  return totals;
};

export interface NotificationHistoryItem {
  channel: string;
  template: string;
  status: string;
  eventId: string;
  sentAt: string | null;
  createdAt: string;
}

// Participant-facing history, matched by the caller's email.
export const listForEmail = async (
  db: DbClient,
  email: string,
): Promise<NotificationHistoryItem[]> => {
  const rows = await db
    .select({
      id: participants.id,
    })
    .from(participants)
    .where(eq(participants.email, email.toLowerCase()));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const notes = await db
    .select({
      channel: participantNotifications.channel,
      template: participantNotifications.template,
      status: participantNotifications.status,
      eventId: participantNotifications.eventId,
      sentAt: participantNotifications.sentAt,
      createdAt: participantNotifications.createdAt,
    })
    .from(participantNotifications)
    .where(inArray(participantNotifications.participantId, ids));
  return notes.map((n) => ({
    channel: n.channel,
    template: n.template,
    status: n.status,
    eventId: n.eventId,
    sentAt: n.sentAt ? n.sentAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  }));
};

// Operator resend for one participant: enqueue for that participant's event.
export class NotificationError extends Error {
  constructor(
    public readonly code: 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'NotificationError';
  }
}

export const resendForParticipant = async (
  db: DbClient,
  participantId: string,
  opts: { now?: Date } = {},
): Promise<EnqueueResult> => {
  const rows = await db
    .select({ eventId: participants.eventId })
    .from(participants)
    .where(eq(participants.id, participantId))
    .limit(1);
  const eventId = rows[0]?.eventId;
  if (!eventId) throw new NotificationError('not_found', 'participant not found');
  return enqueueForEvent(db, eventId, opts);
};
