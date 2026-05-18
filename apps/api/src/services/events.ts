// Events service layer. Pure functions over the DbClient — no Fastify or
// HTTP concerns leak in here. Route handlers stay thin and testable, and
// these functions are unit-testable without a running server.
//
// Org-scoped reads are enforced by `viewerOrgIds`: callers MUST resolve the
// authenticated user's org memberships and pass them in. A missing
// `viewerOrgIds` would let a logged-in user enumerate every org's events.

import { randomBytes } from 'node:crypto';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, asc, desc, eq, gte, ilike, lt, or, sql } from 'drizzle-orm';
import { hashPassword } from '../auth/passwords.js';
import { type CursorPayload, decodeCursor, encodeCursor } from '../lib/cursor.js';

const { events, eventMembers, eventSettings, eventFtpCredentials } = schema.events.tables;
const { organizationMembers } = schema.users.tables;
const { auditLog } = schema.compliance.tables;

// ---------- Types ----------

export type EventStatus = 'draft' | 'published' | 'archived';
export type EventMemberRole = 'organizer' | 'photographer' | 'assistant';

export interface ListEventsInput {
  viewerOrgIds: string[];
  orgId?: string;
  status?: EventStatus;
  after?: Date;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface ListEventsResult {
  events: Array<typeof events.$inferSelect>;
  nextCursor: string | null;
}

export interface CreateEventInput {
  orgId: string;
  name: string;
  slug: string;
  eventDate: Date;
  location?: string;
  timezone?: string;
  description?: string;
  retentionDays?: number;
  currency?: string;
  actorUserId: string;
}

export interface UpdateEventInput {
  name?: string;
  slug?: string;
  description?: string | null;
  eventDate?: Date;
  location?: string | null;
  timezone?: string;
  retentionDays?: number;
  currency?: string;
  allowFaceSearch?: boolean;
  coverPhotoId?: string | null;
}

export interface AddMemberInput {
  eventId: string;
  userId: string;
  role: EventMemberRole;
  splitPct?: number;
  actorUserId: string;
}

export interface UpdateMemberInput {
  eventId: string;
  userId: string;
  role?: EventMemberRole;
  splitPct?: number;
  actorUserId: string;
}

export interface RotateFtpCredentialResult {
  id: string;
  username: string;
  password: string;
  expiresAt: Date;
}

// ---------- Errors ----------

export class EventServiceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'conflict' | 'forbidden' | 'invalid' | 'split_pct_overflow',
    message: string,
  ) {
    super(message);
    this.name = 'EventServiceError';
  }
}

// ---------- Helpers ----------

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export const normalizeSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const clampLimit = (raw: number | undefined): number => {
  if (!raw || raw < 1) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
};

const writeAudit = async (
  db: DbClient,
  args: {
    actorUserId: string;
    action: string;
    eventId: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> => {
  await db.insert(auditLog).values({
    actorUserId: args.actorUserId,
    actorKind: 'user',
    action: args.action,
    targetKind: 'event',
    targetId: args.eventId,
    eventId: args.eventId,
    payloadJsonb: args.payload ?? null,
  });
};

// Sum of split_pct across photographers must not exceed 100. Called both
// for add and update flows. Uses a single aggregate query.
const assertSplitPctInvariant = async (
  db: DbClient,
  eventId: string,
  excludeUserId?: string,
  addingPct?: number,
): Promise<void> => {
  const rows = await db
    .select({
      total: sql<string>`coalesce(sum(${eventMembers.splitPct}), 0)`,
    })
    .from(eventMembers)
    .where(
      and(
        eq(eventMembers.eventId, eventId),
        eq(eventMembers.role, 'photographer'),
        excludeUserId ? sql`${eventMembers.userId} <> ${excludeUserId}` : sql`true`,
      ),
    );
  const current = Number(rows[0]?.total ?? 0);
  const next = current + (addingPct ?? 0);
  if (next > 100) {
    throw new EventServiceError(
      'split_pct_overflow',
      `Sum of photographer split_pct would exceed 100 (got ${next})`,
    );
  }
};

// ---------- Operations ----------

export const listEvents = async (
  db: DbClient,
  input: ListEventsInput,
): Promise<ListEventsResult> => {
  const limit = clampLimit(input.limit);
  const cursor: CursorPayload | null = decodeCursor(input.cursor);

  const orgScope =
    input.viewerOrgIds.length === 0
      ? sql`false`
      : sql`${events.orgId} in (${sql.join(
          input.viewerOrgIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;

  const filters = [orgScope];
  if (input.orgId) filters.push(eq(events.orgId, input.orgId));
  if (input.status) filters.push(eq(events.status, input.status));
  if (input.after) filters.push(gte(events.eventDate, input.after));
  if (input.q) filters.push(ilike(events.name, `%${input.q}%`));
  if (cursor) {
    // Keyset: (createdAt desc, id desc) — strictly after the cursor.
    // `or()` returns SQL | undefined; guard the result instead of using a non-null assertion.
    const cursorCondition = or(
      lt(events.createdAt, cursor.createdAt),
      and(eq(events.createdAt, cursor.createdAt), lt(events.id, cursor.id)),
    );
    if (cursorCondition) filters.push(cursorCondition);
  }

  const rows = await db
    .select()
    .from(events)
    .where(and(...filters))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const last = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ id: last.id, createdAt: last.createdAt }) : null;

  return { events: trimmed, nextCursor };
};

export const createEvent = async (
  db: DbClient,
  input: CreateEventInput,
): Promise<typeof events.$inferSelect> => {
  const slug = normalizeSlug(input.slug);
  if (!slug) {
    throw new EventServiceError('invalid', 'slug normalizes to empty string');
  }

  // Pre-check for slug collision so we can return a clean 409.
  const existing = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.orgId, input.orgId), eq(events.slug, slug)))
    .limit(1);
  if (existing.length > 0) {
    throw new EventServiceError('conflict', 'slug already exists in this org');
  }

  const inserted = await db
    .insert(events)
    .values({
      orgId: input.orgId,
      name: input.name,
      slug,
      eventDate: input.eventDate,
      location: input.location ?? null,
      timezone: input.timezone ?? 'UTC',
      description: input.description ?? null,
      retentionDays: input.retentionDays ?? 30,
      currency: input.currency ?? 'USD',
      status: 'draft',
    })
    .returning();

  const event = inserted[0];
  if (!event) {
    throw new EventServiceError('invalid', 'insert returned no row');
  }

  await db.insert(eventSettings).values({ eventId: event.id });

  await writeAudit(db, {
    actorUserId: input.actorUserId,
    action: 'event.created',
    eventId: event.id,
    payload: { name: event.name, slug: event.slug, orgId: event.orgId },
  });

  return event;
};

export interface EventWithRelations {
  event: typeof events.$inferSelect;
  members: Array<typeof eventMembers.$inferSelect>;
  settings: typeof eventSettings.$inferSelect | null;
}

export const getEvent = async (
  db: DbClient,
  eventId: string,
  viewerOrgIds: string[],
): Promise<EventWithRelations> => {
  const rows = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  const event = rows[0];
  if (!event) {
    throw new EventServiceError('not_found', 'event not found');
  }
  if (!viewerOrgIds.includes(event.orgId)) {
    // Hide existence from non-members.
    throw new EventServiceError('not_found', 'event not found');
  }

  const [members, settingsRows] = await Promise.all([
    db.select().from(eventMembers).where(eq(eventMembers.eventId, eventId)),
    db.select().from(eventSettings).where(eq(eventSettings.eventId, eventId)).limit(1),
  ]);

  return {
    event,
    members,
    settings: settingsRows[0] ?? null,
  };
};

export const updateEvent = async (
  db: DbClient,
  eventId: string,
  patch: UpdateEventInput,
  actorUserId: string,
  viewerOrgIds: string[],
): Promise<typeof events.$inferSelect> => {
  const existing = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  const current = existing[0];
  if (!current || !viewerOrgIds.includes(current.orgId)) {
    throw new EventServiceError('not_found', 'event not found');
  }

  const nextSlug = patch.slug ? normalizeSlug(patch.slug) : undefined;
  if (nextSlug && nextSlug !== current.slug) {
    const collision = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.orgId, current.orgId), eq(events.slug, nextSlug)))
      .limit(1);
    if (collision.length > 0) {
      throw new EventServiceError('conflict', 'slug already exists in this org');
    }
  }

  const updated = await db
    .update(events)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(nextSlug !== undefined ? { slug: nextSlug } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.eventDate !== undefined ? { eventDate: patch.eventDate } : {}),
      ...(patch.location !== undefined ? { location: patch.location } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.retentionDays !== undefined ? { retentionDays: patch.retentionDays } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.allowFaceSearch !== undefined ? { allowFaceSearch: patch.allowFaceSearch } : {}),
      ...(patch.coverPhotoId !== undefined ? { coverPhotoId: patch.coverPhotoId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(events.id, eventId))
    .returning();

  const next = updated[0];
  if (!next) {
    throw new EventServiceError('not_found', 'event vanished mid-update');
  }

  await writeAudit(db, {
    actorUserId,
    action: 'event.updated',
    eventId,
    payload: { patch },
  });

  return next;
};

export const archiveEvent = async (
  db: DbClient,
  eventId: string,
  actorUserId: string,
  viewerOrgIds: string[],
): Promise<typeof events.$inferSelect> => {
  const existing = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  const current = existing[0];
  if (!current || !viewerOrgIds.includes(current.orgId)) {
    throw new EventServiceError('not_found', 'event not found');
  }

  const updated = await db
    .update(events)
    .set({
      status: 'archived',
      archivedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(events.id, eventId))
    .returning();

  const next = updated[0];
  if (!next) {
    throw new EventServiceError('not_found', 'event vanished mid-archive');
  }

  await writeAudit(db, {
    actorUserId,
    action: 'event.archived',
    eventId,
  });

  return next;
};

export const publishEvent = async (
  db: DbClient,
  eventId: string,
  actorUserId: string,
  viewerOrgIds: string[],
): Promise<typeof events.$inferSelect> => {
  const existing = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  const current = existing[0];
  if (!current || !viewerOrgIds.includes(current.orgId)) {
    throw new EventServiceError('not_found', 'event not found');
  }

  // Idempotent: publishing an already-published event is a no-op.
  if (current.status === 'published') {
    return current;
  }

  if (current.status === 'archived') {
    throw new EventServiceError('invalid', 'cannot publish an archived event');
  }

  const updated = await db
    .update(events)
    .set({
      status: 'published',
      publishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(events.id, eventId))
    .returning();

  const next = updated[0];
  if (!next) {
    throw new EventServiceError('not_found', 'event vanished mid-publish');
  }

  await writeAudit(db, {
    actorUserId,
    action: 'event.published',
    eventId,
  });

  return next;
};

export const addMember = async (
  db: DbClient,
  input: AddMemberInput,
): Promise<typeof eventMembers.$inferSelect> => {
  const splitPct = input.splitPct ?? 0;
  if (splitPct < 0 || splitPct > 100) {
    throw new EventServiceError('invalid', 'splitPct must be between 0 and 100');
  }

  if (input.role === 'photographer' && splitPct > 0) {
    await assertSplitPctInvariant(db, input.eventId, undefined, splitPct);
  }

  const inserted = await db
    .insert(eventMembers)
    .values({
      eventId: input.eventId,
      userId: input.userId,
      role: input.role,
      splitPct: splitPct.toFixed(2),
    })
    .returning();

  const row = inserted[0];
  if (!row) {
    throw new EventServiceError('invalid', 'insert returned no row');
  }

  await writeAudit(db, {
    actorUserId: input.actorUserId,
    action: 'event.member.added',
    eventId: input.eventId,
    payload: { userId: input.userId, role: input.role, splitPct },
  });

  return row;
};

export const updateMember = async (
  db: DbClient,
  input: UpdateMemberInput,
): Promise<typeof eventMembers.$inferSelect> => {
  if (input.splitPct !== undefined && (input.splitPct < 0 || input.splitPct > 100)) {
    throw new EventServiceError('invalid', 'splitPct must be between 0 and 100');
  }

  const existing = await db
    .select()
    .from(eventMembers)
    .where(and(eq(eventMembers.eventId, input.eventId), eq(eventMembers.userId, input.userId)))
    .limit(1);
  const current = existing[0];
  if (!current) {
    throw new EventServiceError('not_found', 'event member not found');
  }

  const nextRole = input.role ?? current.role;
  const nextSplit = input.splitPct ?? Number(current.splitPct);

  if (nextRole === 'photographer' && nextSplit > 0) {
    await assertSplitPctInvariant(db, input.eventId, input.userId, nextSplit);
  }

  const updated = await db
    .update(eventMembers)
    .set({
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.splitPct !== undefined ? { splitPct: input.splitPct.toFixed(2) } : {}),
    })
    .where(and(eq(eventMembers.eventId, input.eventId), eq(eventMembers.userId, input.userId)))
    .returning();

  const next = updated[0];
  if (!next) {
    throw new EventServiceError('not_found', 'member vanished mid-update');
  }

  await writeAudit(db, {
    actorUserId: input.actorUserId,
    action: 'event.member.updated',
    eventId: input.eventId,
    payload: { userId: input.userId, role: input.role, splitPct: input.splitPct },
  });

  return next;
};

export const removeMember = async (
  db: DbClient,
  args: { eventId: string; userId: string; actorUserId: string },
): Promise<void> => {
  const deleted = await db
    .delete(eventMembers)
    .where(and(eq(eventMembers.eventId, args.eventId), eq(eventMembers.userId, args.userId)))
    .returning({ userId: eventMembers.userId });

  if (deleted.length === 0) {
    throw new EventServiceError('not_found', 'event member not found');
  }

  await writeAudit(db, {
    actorUserId: args.actorUserId,
    action: 'event.member.removed',
    eventId: args.eventId,
    payload: { userId: args.userId },
  });
};

// Generates a fresh random password for a new FTP credential. Returns the
// plaintext exactly once — caller MUST surface it to the user immediately
// and never persist it.
const generateFtpPassword = (): string => {
  // 32 bytes -> 43 base64url chars, plenty of entropy.
  return randomBytes(32).toString('base64url');
};

const generateFtpUsername = (eventId: string): string => {
  // Short suffix keeps the username readable but unique-per-rotation.
  const suffix = randomBytes(4).toString('hex');
  return `evt-${eventId.replace(/-/g, '').slice(0, 12)}-${suffix}`;
};

export const rotateFtpCredential = async (
  db: DbClient,
  args: {
    eventId: string;
    actorUserId: string;
    ttlDays?: number;
    viewerOrgIds: string[];
  },
): Promise<RotateFtpCredentialResult> => {
  const existing = await db.select().from(events).where(eq(events.id, args.eventId)).limit(1);
  const event = existing[0];
  if (!event || !args.viewerOrgIds.includes(event.orgId)) {
    throw new EventServiceError('not_found', 'event not found');
  }

  // Revoke active credentials before issuing a new one.
  await db
    .update(eventFtpCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(eventFtpCredentials.eventId, args.eventId),
        sql`${eventFtpCredentials.revokedAt} is null`,
      ),
    );

  const password = generateFtpPassword();
  const username = generateFtpUsername(args.eventId);
  const passwordHash = await hashPassword(password);
  const ttlDays = args.ttlDays ?? 14;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const inserted = await db
    .insert(eventFtpCredentials)
    .values({
      eventId: args.eventId,
      username,
      passwordHash,
      expiresAt,
    })
    .returning();

  const cred = inserted[0];
  if (!cred) {
    throw new EventServiceError('invalid', 'insert returned no row');
  }

  await writeAudit(db, {
    actorUserId: args.actorUserId,
    action: 'event.ftp_credential.rotated',
    eventId: args.eventId,
    payload: { credentialId: cred.id, username, expiresAt: expiresAt.toISOString() },
  });

  return {
    id: cred.id,
    username,
    password,
    expiresAt,
  };
};

// Resolves the set of org IDs the user belongs to. Routes call this once
// per request so service functions stay stateless.
export const getViewerOrgIds = async (db: DbClient, userId: string): Promise<string[]> => {
  const rows = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizationMembers.orgId));
  return rows.map((r) => r.orgId);
};
