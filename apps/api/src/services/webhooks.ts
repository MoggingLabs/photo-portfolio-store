// F4.11 — outbound webhook subscriptions (API side).
//
// Subscriptions are per-org. The HMAC secret is generated server-side, shown to
// the caller exactly once at creation, and stored envelope-encrypted. Firing an
// event writes one `pending` webhook_deliveries row per matching enabled
// subscription; the worker cron (jobs/webhook-delivery) performs the signed
// HTTP delivery with retry/backoff. The /test path fires a synthetic event.

import { randomBytes, randomUUID } from 'node:crypto';
import { type DbClient, schema } from '@pkg/db';
import { assertPublicHttpsUrl, encryptCredentials } from '@pkg/integrations';
import { and, desc, eq } from 'drizzle-orm';

const { webhookSubscriptions, webhookDeliveries } = schema.webhooks;

// Domain events a third party may subscribe to. `webhook.test` is internal
// (fired by the test endpoint) and not independently subscribable.
export const SUBSCRIBABLE_EVENT_TYPES = [
  'order.paid',
  'photos.ready_for_bib',
  'event.published',
] as const;
export type WebhookEventType = (typeof SUBSCRIBABLE_EVENT_TYPES)[number];

const isSubscribable = (t: string): t is WebhookEventType =>
  (SUBSCRIBABLE_EVENT_TYPES as readonly string[]).includes(t);

export class WebhookError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_request' | 'invalid_url',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}

export interface SubscriptionView {
  id: string;
  targetUrl: string;
  eventTypes: string[];
  enabled: boolean;
  disabledReason: string | null;
  createdAt: string;
}

const toView = (row: {
  id: string;
  targetUrl: string;
  eventTypes: string[];
  enabled: boolean;
  disabledReason: string | null;
  createdAt: Date;
}): SubscriptionView => ({
  id: row.id,
  targetUrl: row.targetUrl,
  eventTypes: row.eventTypes,
  enabled: row.enabled,
  disabledReason: row.disabledReason,
  createdAt: row.createdAt.toISOString(),
});

export interface CreateSubscriptionInput {
  targetUrl: string;
  eventTypes: string[];
}

export interface CreateSubscriptionDeps {
  masterKey: string;
  allowHttp?: boolean;
}

export interface CreatedSubscription {
  subscription: SubscriptionView;
  // Plaintext signing secret — returned exactly once.
  secret: string;
}

export const createSubscription = async (
  db: DbClient,
  orgId: string,
  input: CreateSubscriptionInput,
  deps: CreateSubscriptionDeps,
): Promise<CreatedSubscription> => {
  const types = [...new Set(input.eventTypes)];
  if (types.length === 0 || !types.every(isSubscribable)) {
    throw new WebhookError('invalid_request', 'eventTypes must be a non-empty set of known events');
  }
  try {
    assertPublicHttpsUrl(input.targetUrl, { allowHttp: deps.allowHttp ?? false });
  } catch (err) {
    throw new WebhookError(
      'invalid_url',
      err instanceof Error ? err.message : 'invalid target url',
    );
  }

  const secret = randomBytes(32).toString('hex');
  const secretEncrypted = encryptCredentials(secret, deps.masterKey);

  const inserted = await db
    .insert(webhookSubscriptions)
    .values({
      orgId,
      targetUrl: input.targetUrl,
      secretEncrypted,
      eventTypes: types,
      enabled: true,
    })
    .returning({
      id: webhookSubscriptions.id,
      targetUrl: webhookSubscriptions.targetUrl,
      eventTypes: webhookSubscriptions.eventTypes,
      enabled: webhookSubscriptions.enabled,
      disabledReason: webhookSubscriptions.disabledReason,
      createdAt: webhookSubscriptions.createdAt,
    });
  const row = inserted[0];
  if (!row) throw new Error('webhook_subscriptions insert returned no row');
  return { subscription: toView(row), secret };
};

export const listSubscriptions = async (
  db: DbClient,
  orgId: string,
): Promise<SubscriptionView[]> => {
  const rows = await db
    .select({
      id: webhookSubscriptions.id,
      targetUrl: webhookSubscriptions.targetUrl,
      eventTypes: webhookSubscriptions.eventTypes,
      enabled: webhookSubscriptions.enabled,
      disabledReason: webhookSubscriptions.disabledReason,
      createdAt: webhookSubscriptions.createdAt,
    })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.orgId, orgId))
    .orderBy(desc(webhookSubscriptions.createdAt));
  return rows.map(toView);
};

// Soft-disable: stop deliveries, keep the row + log for audit.
export const deleteSubscription = async (
  db: DbClient,
  orgId: string,
  id: string,
): Promise<void> => {
  await db
    .update(webhookSubscriptions)
    .set({ enabled: false, disabledReason: 'deleted', updatedAt: new Date() })
    .where(and(eq(webhookSubscriptions.orgId, orgId), eq(webhookSubscriptions.id, id)));
};

// Find a subscription owned by the org (used to gate test/deliveries by owner).
const ownedSubscription = async (
  db: DbClient,
  orgId: string,
  id: string,
): Promise<{ id: string; eventTypes: string[] } | null> => {
  const rows = await db
    .select({ id: webhookSubscriptions.id, eventTypes: webhookSubscriptions.eventTypes })
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.orgId, orgId), eq(webhookSubscriptions.id, id)))
    .limit(1);
  return rows[0] ?? null;
};

export interface DeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  attempt: number;
  status: string;
  httpStatus: number | null;
  scheduledAt: string;
  deliveredAt: string | null;
  nextRetryAt: string | null;
}

export const listDeliveries = async (
  db: DbClient,
  orgId: string,
  subscriptionId: string,
  limit = 50,
): Promise<DeliveryView[]> => {
  const owned = await ownedSubscription(db, orgId, subscriptionId);
  if (!owned) throw new WebhookError('not_found', 'subscription not found');
  const rows = await db
    .select({
      id: webhookDeliveries.id,
      eventId: webhookDeliveries.eventId,
      eventType: webhookDeliveries.eventType,
      attempt: webhookDeliveries.attempt,
      status: webhookDeliveries.status,
      httpStatus: webhookDeliveries.httpStatus,
      scheduledAt: webhookDeliveries.scheduledAt,
      deliveredAt: webhookDeliveries.deliveredAt,
      nextRetryAt: webhookDeliveries.nextRetryAt,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
    .orderBy(desc(webhookDeliveries.scheduledAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    eventType: r.eventType,
    attempt: r.attempt,
    status: r.status,
    httpStatus: r.httpStatus,
    scheduledAt: r.scheduledAt.toISOString(),
    deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
    nextRetryAt: r.nextRetryAt ? r.nextRetryAt.toISOString() : null,
  }));
};

// Fan a fired event out to matching enabled subscriptions by writing one
// `pending` delivery row each. Returns the number of deliveries enqueued.
// Exposed for domain-event producers (order.paid, etc., wired in later issues).
export const enqueueEvent = async (
  db: DbClient,
  orgId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<{ enqueued: number; eventId: string }> => {
  const eventId = randomUUID();
  const subs = await db
    .select({ id: webhookSubscriptions.id, eventTypes: webhookSubscriptions.eventTypes })
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.orgId, orgId), eq(webhookSubscriptions.enabled, true)));
  const matching = subs.filter((s) => s.eventTypes.includes(eventType));
  if (matching.length === 0) return { enqueued: 0, eventId };

  await db.insert(webhookDeliveries).values(
    matching.map((s) => ({
      subscriptionId: s.id,
      eventId,
      eventType,
      attempt: 1,
      status: 'pending' as const,
      payloadJson: { event: eventType, id: eventId, data: payload },
    })),
  );
  return { enqueued: matching.length, eventId };
};

// Fire a synthetic event to a single subscription (the /test endpoint).
export const testSubscription = async (
  db: DbClient,
  orgId: string,
  id: string,
): Promise<{ eventId: string }> => {
  const owned = await ownedSubscription(db, orgId, id);
  if (!owned) throw new WebhookError('not_found', 'subscription not found');
  const eventId = randomUUID();
  await db.insert(webhookDeliveries).values({
    subscriptionId: id,
    eventId,
    eventType: 'webhook.test',
    attempt: 1,
    status: 'pending',
    payloadJson: { event: 'webhook.test', id: eventId, data: { ok: true } },
  });
  return { eventId };
};
