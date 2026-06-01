// F4.6+ — timing provider bindings (API side).
//
// Binds an event to an external race at a timing provider and stores the
// provider credentials envelope-encrypted. The sync itself runs in the worker
// (jobs/timing-sync); /sync here just marks intent. Credentials are never
// returned.

import { type DbClient, schema } from '@pkg/db';
import { encryptCredentials } from '@pkg/integrations';
import type { TimingProvider } from '@pkg/integrations';
import { and, desc, eq } from 'drizzle-orm';

const { eventTimingBindings } = schema.timing;

export class TimingBindingError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'TimingBindingError';
  }
}

export interface BindInput {
  eventId: string;
  provider: TimingProvider;
  externalEventId: string;
  apiKey: string;
}

export interface BindDeps {
  masterKey: string;
}

export interface TimingBindingView {
  provider: string;
  externalEventId: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

const toView = (row: {
  provider: string;
  externalEventId: string;
  enabled: boolean;
  lastSyncedAt: Date | null;
  lastError: string | null;
}): TimingBindingView => ({
  provider: row.provider,
  externalEventId: row.externalEventId,
  enabled: row.enabled,
  lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  lastError: row.lastError,
});

export const bindTimingProvider = async (
  db: DbClient,
  input: BindInput,
  deps: BindDeps,
): Promise<TimingBindingView> => {
  const credentialsEncrypted = encryptCredentials(input.apiKey, deps.masterKey);
  const now = new Date();
  await db
    .insert(eventTimingBindings)
    .values({
      eventId: input.eventId,
      provider: input.provider,
      externalEventId: input.externalEventId,
      credentialsEncrypted,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [eventTimingBindings.eventId, eventTimingBindings.provider],
      set: {
        externalEventId: input.externalEventId,
        credentialsEncrypted,
        enabled: true,
        lastError: null,
        updatedAt: now,
      },
    });
  return getBinding(db, input.eventId, input.provider);
};

export const requestSync = async (
  db: DbClient,
  eventId: string,
  provider: TimingProvider,
): Promise<{ requested: true }> => {
  const updated = await db
    .update(eventTimingBindings)
    .set({ syncRequestedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(eventTimingBindings.eventId, eventId), eq(eventTimingBindings.provider, provider)),
    )
    .returning({ id: eventTimingBindings.id });
  if (updated.length === 0) throw new TimingBindingError('not_found', 'timing binding not found');
  return { requested: true };
};

export const listBindings = async (db: DbClient, eventId: string): Promise<TimingBindingView[]> => {
  const rows = await db
    .select({
      provider: eventTimingBindings.provider,
      externalEventId: eventTimingBindings.externalEventId,
      enabled: eventTimingBindings.enabled,
      lastSyncedAt: eventTimingBindings.lastSyncedAt,
      lastError: eventTimingBindings.lastError,
    })
    .from(eventTimingBindings)
    .where(eq(eventTimingBindings.eventId, eventId))
    .orderBy(desc(eventTimingBindings.createdAt));
  return rows.map(toView);
};

const getBinding = async (
  db: DbClient,
  eventId: string,
  provider: TimingProvider,
): Promise<TimingBindingView> => {
  const rows = await db
    .select({
      provider: eventTimingBindings.provider,
      externalEventId: eventTimingBindings.externalEventId,
      enabled: eventTimingBindings.enabled,
      lastSyncedAt: eventTimingBindings.lastSyncedAt,
      lastError: eventTimingBindings.lastError,
    })
    .from(eventTimingBindings)
    .where(
      and(eq(eventTimingBindings.eventId, eventId), eq(eventTimingBindings.provider, provider)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new TimingBindingError('not_found', 'timing binding not found');
  return toView(row);
};
