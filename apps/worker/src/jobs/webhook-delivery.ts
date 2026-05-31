// F4.11 — outbound webhook delivery sweep.
//
// Cron-driven (every minute). Picks up due deliveries (status pending/retrying
// with next_retry_at <= now), signs the body with the subscription's HMAC
// secret, and POSTs it. Outcome handling:
//   2xx                -> delivered; subscription failure streak reset.
//   410 Gone           -> delivery failed; subscription disabled (no retries).
//   other 4xx          -> delivery failed (misconfigured; no retries).
//   5xx / network / TO -> retry per backoff schedule until MAX_ATTEMPTS, then
//                         fail + disable; failure streak drives a circuit breaker.
//
// The HTTP client and clock are injectable so the logic is unit-testable
// without a live receiver. The worker re-checks the target URL with the SSRF
// guard at send time (defense-in-depth against post-creation DNS changes).

import { type DbClient, schema } from '@pkg/db';
import { assertPublicHttpsUrl, decryptCredentials, signWebhookBody } from '@pkg/integrations';
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';

const { webhookSubscriptions, webhookDeliveries } = schema.webhooks;

// Backoff delays between attempts (ms): 30s, 2m, 10m, 1h, 6h, 24h.
export const RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];
// attempt 1 is the initial send; up to RETRY_DELAYS_MS.length retries follow.
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 10 * 60_000;
const BODY_EXCERPT_MAX = 2048;
const BATCH_LIMIT = 100;

export interface HttpResponse {
  status: number;
  body: string;
}

// Injectable HTTP client: resolves with the response, or rejects on network
// error / timeout (treated as retryable).
export type WebhookHttpClient = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<HttpResponse>;

export interface WebhookDeliveryDeps {
  masterKey?: string;
  httpClient: WebhookHttpClient;
  now?: () => Date;
  jitter?: (base: number) => number;
}

export interface DeliverySweepResult {
  processed: number;
  delivered: number;
  retried: number;
  failed: number;
}

const jitterDefault = (base: number): number => base * (0.85 + Math.random() * 0.3);

interface DueRow {
  deliveryId: string;
  subscriptionId: string;
  attempt: number;
  eventId: string;
  eventType: string;
  payloadJson: unknown;
  targetUrl: string;
  secretEncrypted: string;
  enabled: boolean;
  cooldownUntil: Date | null;
  consecutiveFailures: number;
}

const isRetryable = (status: number): boolean => status >= 500;

export const runWebhookDeliveries = async (
  db: DbClient,
  deps: WebhookDeliveryDeps,
): Promise<DeliverySweepResult> => {
  const now = deps.now ?? (() => new Date());
  const jitter = deps.jitter ?? jitterDefault;
  const nowTs = now();

  const due = (await db
    .select({
      deliveryId: webhookDeliveries.id,
      subscriptionId: webhookDeliveries.subscriptionId,
      attempt: webhookDeliveries.attempt,
      eventId: webhookDeliveries.eventId,
      eventType: webhookDeliveries.eventType,
      payloadJson: webhookDeliveries.payloadJson,
      targetUrl: webhookSubscriptions.targetUrl,
      secretEncrypted: webhookSubscriptions.secretEncrypted,
      enabled: webhookSubscriptions.enabled,
      cooldownUntil: webhookSubscriptions.cooldownUntil,
      consecutiveFailures: webhookSubscriptions.consecutiveFailures,
    })
    .from(webhookDeliveries)
    .innerJoin(webhookSubscriptions, eq(webhookDeliveries.subscriptionId, webhookSubscriptions.id))
    .where(
      and(
        or(eq(webhookDeliveries.status, 'pending'), eq(webhookDeliveries.status, 'retrying')),
        or(isNull(webhookDeliveries.nextRetryAt), lte(webhookDeliveries.nextRetryAt, nowTs)),
      ),
    )
    .orderBy(asc(webhookDeliveries.scheduledAt))
    .limit(BATCH_LIMIT)) as DueRow[];

  const result: DeliverySweepResult = { processed: 0, delivered: 0, retried: 0, failed: 0 };

  for (const row of due) {
    result.processed += 1;

    if (!row.enabled) {
      await failDelivery(db, row.deliveryId, null, 'subscription disabled', now());
      result.failed += 1;
      continue;
    }
    if (row.cooldownUntil && row.cooldownUntil.getTime() > nowTs.getTime()) {
      // Circuit open: defer this delivery to the cooldown boundary.
      await db
        .update(webhookDeliveries)
        .set({ status: 'retrying', nextRetryAt: row.cooldownUntil })
        .where(eq(webhookDeliveries.id, row.deliveryId));
      result.retried += 1;
      continue;
    }

    const masterKey = deps.masterKey;
    if (!masterKey) throw new Error('INTEGRATIONS_MASTER_KEY is required to deliver webhooks');

    const outcome = await attemptDelivery(row, masterKey, deps.httpClient, now());

    if (outcome.kind === 'delivered') {
      await markDelivered(db, row.deliveryId, outcome.status, outcome.excerpt, now());
      await resetCircuit(db, row.subscriptionId, now());
      result.delivered += 1;
    } else if (outcome.kind === 'retry' && row.attempt < MAX_ATTEMPTS) {
      const delay = jitter(RETRY_DELAYS_MS[row.attempt - 1] ?? RETRY_DELAYS_MS[0] ?? 30_000);
      const nextRetryAt = new Date(now().getTime() + delay);
      await db
        .update(webhookDeliveries)
        .set({
          status: 'retrying',
          attempt: row.attempt + 1,
          httpStatus: outcome.status ?? null,
          responseBodyExcerpt: outcome.excerpt ?? null,
          nextRetryAt,
        })
        .where(eq(webhookDeliveries.id, row.deliveryId));
      await bumpCircuit(db, row.subscriptionId, row.consecutiveFailures + 1, now());
      result.retried += 1;
    } else {
      // Hard fail: 4xx (no retry), 410 (disable), or retries exhausted.
      await failDelivery(
        db,
        row.deliveryId,
        outcome.status ?? null,
        outcome.excerpt ?? null,
        now(),
      );
      if (outcome.kind === 'disable') {
        await disableSubscription(db, row.subscriptionId, 'gone', now());
      } else if (outcome.kind === 'retry') {
        await disableSubscription(db, row.subscriptionId, 'max_retries', now());
      } else {
        await bumpCircuit(db, row.subscriptionId, row.consecutiveFailures + 1, now());
      }
      result.failed += 1;
    }
  }

  return result;
};

type Outcome =
  | { kind: 'delivered'; status: number; excerpt: string }
  | { kind: 'disable'; status: number; excerpt: string } // 410
  | { kind: 'fail'; status: number; excerpt: string } // other 4xx
  | { kind: 'retry'; status?: number; excerpt?: string }; // 5xx / network

const attemptDelivery = async (
  row: DueRow,
  masterKey: string,
  httpClient: WebhookHttpClient,
  now: Date,
): Promise<Outcome> => {
  try {
    assertPublicHttpsUrl(row.targetUrl, { allowHttp: process.env.NODE_ENV !== 'production' });
  } catch {
    return { kind: 'fail', status: 0, excerpt: 'blocked target url (ssrf guard)' };
  }

  let secret: string;
  try {
    secret = decryptCredentials(row.secretEncrypted, masterKey);
  } catch {
    return { kind: 'fail', status: 0, excerpt: 'secret decryption failed' };
  }

  const body = JSON.stringify(row.payloadJson ?? {});
  const timestamp = Math.floor(now.getTime() / 1000);
  const headers = {
    'content-type': 'application/json',
    'x-webhook-id': row.eventId,
    'x-webhook-timestamp': String(timestamp),
    'x-webhook-event': row.eventType,
    'x-webhook-signature': signWebhookBody(secret, timestamp, body),
  };

  try {
    const res = await httpClient(row.targetUrl, body, headers);
    const excerpt = (res.body ?? '').slice(0, BODY_EXCERPT_MAX);
    if (res.status >= 200 && res.status < 300)
      return { kind: 'delivered', status: res.status, excerpt };
    if (res.status === 410) return { kind: 'disable', status: res.status, excerpt };
    if (isRetryable(res.status)) return { kind: 'retry', status: res.status, excerpt };
    return { kind: 'fail', status: res.status, excerpt };
  } catch (err) {
    return {
      kind: 'retry',
      excerpt: err instanceof Error ? err.message.slice(0, BODY_EXCERPT_MAX) : 'network error',
    };
  }
};

const markDelivered = (
  db: DbClient,
  id: string,
  status: number,
  excerpt: string,
  now: Date,
): Promise<unknown> =>
  db
    .update(webhookDeliveries)
    .set({
      status: 'delivered',
      httpStatus: status,
      responseBodyExcerpt: excerpt,
      deliveredAt: now,
      nextRetryAt: null,
    })
    .where(eq(webhookDeliveries.id, id));

const failDelivery = (
  db: DbClient,
  id: string,
  status: number | null,
  excerpt: string | null,
  _now: Date,
): Promise<unknown> =>
  db
    .update(webhookDeliveries)
    .set({ status: 'failed', httpStatus: status, responseBodyExcerpt: excerpt, nextRetryAt: null })
    .where(eq(webhookDeliveries.id, id));

const resetCircuit = (db: DbClient, subId: string, now: Date): Promise<unknown> =>
  db
    .update(webhookSubscriptions)
    .set({ consecutiveFailures: 0, cooldownUntil: null, updatedAt: now })
    .where(eq(webhookSubscriptions.id, subId));

const bumpCircuit = (
  db: DbClient,
  subId: string,
  failures: number,
  now: Date,
): Promise<unknown> => {
  const cooldownUntil =
    failures >= CIRCUIT_FAILURE_THRESHOLD ? new Date(now.getTime() + CIRCUIT_COOLDOWN_MS) : null;
  return db
    .update(webhookSubscriptions)
    .set({
      consecutiveFailures: failures,
      ...(cooldownUntil ? { cooldownUntil } : {}),
      updatedAt: now,
    })
    .where(eq(webhookSubscriptions.id, subId));
};

const disableSubscription = (
  db: DbClient,
  subId: string,
  reason: string,
  now: Date,
): Promise<unknown> =>
  db
    .update(webhookSubscriptions)
    .set({ enabled: false, disabledReason: reason, updatedAt: now })
    .where(eq(webhookSubscriptions.id, subId));
