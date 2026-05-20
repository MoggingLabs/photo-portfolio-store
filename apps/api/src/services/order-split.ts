// F2.10 — multi-photographer split engine.
//
// Attribution is PER PHOTO:
//   - Single-photo item  → full line goes to that photo's photographerUserId.
//   - Bundle item        → line is split across snapshot photos' photographers
//                          weighted by how many snapshot photos each owns,
//                          via allocateProportional (cents-exact).
//   - Unresolvable photo → fall back to event_members.splitPct for that event.
//                          If splitPct is also unavailable (e.g. 0 for all),
//                          the first photographer member (by insertion order)
//                          absorbs the unattributed amount. This is documented
//                          behaviour and can be corrected with an 'adjustment'
//                          ledger entry.
//
// Fee order (locked decision): platform fee deducted first, then stripe fee;
// both are applied to gross G. Distributable = G - P - S is split across
// photographers weighted by their attributed gross.
//
// Idempotency: recordOrderSale calls postLedgerBatch which is order-scoped
// dedupe via partial unique index. Webhook replays are safe.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { eq, inArray } from 'drizzle-orm';

import {
  type LedgerEntryInput,
  allocateProportional,
  assertBalanced,
  ensurePhotographerAccount,
  estimatePlatformFeeCents,
  estimateStripeFeeCents,
  getPlatformAccountId,
  postLedgerBatch,
} from './ledger.js';

const { orders, orderItems } = schema.commerce.tables;
const { photos } = schema.photos.tables;
const { eventMembers } = schema.events.tables;

// ---------- Types ----------

export interface SplitResult {
  entries: LedgerEntryInput[];
  totalCents: number;
  platformFeeCents: number;
  stripeFeeCents: number;
  photographerNetByUserId: Record<string, number>;
}

// Internal: weight map from photographerUserId -> gross cents attributed.
type GrossWeightMap = Map<string, number>;

// ---------- Metadata shape (zod-lite inline validation) ----------

interface BundleMetadata {
  bundleId: string;
  bundleSnapshot: string[];
}

const isBundleMetadata = (v: unknown): v is BundleMetadata =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Record<string, unknown>).bundleId === 'string' &&
  Array.isArray((v as Record<string, unknown>).bundleSnapshot);

// ---------- Fallback: resolve via splitPct ----------

const resolveFallbackPhotographers = async (
  db: DbClient,
  eventId: string,
): Promise<Array<{ userId: string; splitPct: number }>> => {
  const members = await db
    .select({ userId: eventMembers.userId, splitPct: eventMembers.splitPct })
    .from(eventMembers)
    .where(eq(eventMembers.eventId, eventId));

  return members
    .filter((m) => {
      const pct = Number.parseFloat(m.splitPct ?? '0');
      return pct > 0;
    })
    .map((m) => ({ userId: m.userId, splitPct: Number.parseFloat(m.splitPct ?? '0') }));
};

const resolveFallbackFirstMember = async (
  db: DbClient,
  eventId: string,
): Promise<string | null> => {
  const members = await db
    .select({ userId: eventMembers.userId })
    .from(eventMembers)
    .where(eq(eventMembers.eventId, eventId))
    .limit(1);
  const [first] = members;
  return first ? first.userId : null;
};

// ---------- Attribution helpers ----------

const addToWeightMap = (map: GrossWeightMap, userId: string, cents: number): void => {
  map.set(userId, (map.get(userId) ?? 0) + cents);
};

// Attribute a set of photoIds for a single item line using the fallback
// (splitPct or first member) when a photo's photographer cannot be resolved.
const attributeViaFallback = async (
  db: DbClient,
  eventId: string,
  lineTotalCents: number,
  map: GrossWeightMap,
): Promise<void> => {
  const fallbacks = await resolveFallbackPhotographers(db, eventId);
  if (fallbacks.length > 0) {
    const weights = fallbacks.map((f) => f.splitPct);
    const amounts = allocateProportional(lineTotalCents, weights);
    for (let i = 0; i < fallbacks.length; i += 1) {
      const fb = fallbacks[i];
      const amt = amounts[i];
      if (fb && amt !== undefined && amt > 0) {
        addToWeightMap(map, fb.userId, amt);
      }
    }
  } else {
    // Last resort: first member absorbs everything.
    const firstMember = await resolveFallbackFirstMember(db, eventId);
    if (firstMember) {
      addToWeightMap(map, firstMember, lineTotalCents);
    }
    // If there are no members at all (degenerate event), the line is silently
    // dropped from the weight map, which means the amount will be attributed to
    // whichever photographer has the highest weight via allocateProportional
    // when we normalise the gross later — keeping the batch balanced.
  }
};

// ---------- Core compute ----------

export const computeOrderSplit = async (db: DbClient, orderId: string): Promise<SplitResult> => {
  // 1. Load order.
  const orderRows = await db
    .select({
      id: orders.id,
      totalCents: orders.totalCents,
      currency: orders.currency,
      eventId: orders.eventId,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  const [order] = orderRows;
  if (!order) {
    throw new Error(`order-split: order not found: ${orderId}`);
  }

  const { totalCents: grossG, currency, eventId } = order;

  // 2. Load order items.
  const items = await db
    .select({
      id: orderItems.id,
      photoId: orderItems.photoId,
      lineTotalCents: orderItems.lineTotalCents,
      metadataJsonb: orderItems.metadataJsonb,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  // 3. Build photographerUserId -> attributed gross cents map.
  const grossMap: GrossWeightMap = new Map();

  for (const item of items) {
    const lineTotal = item.lineTotalCents;

    if (item.photoId !== null) {
      // Single-photo item: look up photographer directly.
      const photoRows = await db
        .select({ photographerUserId: photos.photographerUserId })
        .from(photos)
        .where(eq(photos.id, item.photoId))
        .limit(1);
      const [photo] = photoRows;
      if (photo) {
        addToWeightMap(grossMap, photo.photographerUserId, lineTotal);
      } else {
        // Photo record missing — fall back to event_members.
        await attributeViaFallback(db, eventId, lineTotal, grossMap);
      }
    } else {
      // Bundle item: use bundleSnapshot from metadataJsonb.
      const meta = item.metadataJsonb;
      if (isBundleMetadata(meta) && meta.bundleSnapshot.length > 0) {
        const snapshotIds = meta.bundleSnapshot;

        // Load all snapshot photos at once.
        const snapshotPhotos = await db
          .select({ id: photos.id, photographerUserId: photos.photographerUserId })
          .from(photos)
          .where(inArray(photos.id, snapshotIds));

        // Build a map photoId -> photographerUserId for resolved photos.
        const photoPhotographerMap = new Map<string, string>(
          snapshotPhotos.map((p) => [p.id, p.photographerUserId]),
        );

        // Count how many snapshot photos each photographer owns.
        const photographerPhotoCount = new Map<string, number>();
        const unresolvableCount = { value: 0 };

        for (const photoId of snapshotIds) {
          const uid = photoPhotographerMap.get(photoId);
          if (uid) {
            photographerPhotoCount.set(uid, (photographerPhotoCount.get(uid) ?? 0) + 1);
          } else {
            unresolvableCount.value += 1;
          }
        }

        // Split lineTotal by photo count weight via allocateProportional.
        const photographerIds = [...photographerPhotoCount.keys()];
        const counts = photographerIds.map((uid) => photographerPhotoCount.get(uid) ?? 0);

        const totalCountForSplit = photographerIds.reduce(
          (s, uid) => s + (photographerPhotoCount.get(uid) ?? 0),
          0,
        );
        const resolvedLineTotal =
          unresolvableCount.value > 0
            ? (allocateProportional(lineTotal, [totalCountForSplit, unresolvableCount.value])[0] ??
              lineTotal)
            : lineTotal;

        const unresolvableLineTotal = lineTotal - resolvedLineTotal;

        if (photographerIds.length > 0 && resolvedLineTotal > 0) {
          const amounts = allocateProportional(resolvedLineTotal, counts);
          for (let i = 0; i < photographerIds.length; i += 1) {
            const uid = photographerIds[i];
            const amt = amounts[i];
            if (uid && amt !== undefined && amt > 0) {
              addToWeightMap(grossMap, uid, amt);
            }
          }
        }

        if (unresolvableLineTotal > 0) {
          await attributeViaFallback(db, eventId, unresolvableLineTotal, grossMap);
        }
      } else {
        // Bundle with no snapshot — full fallback.
        await attributeViaFallback(db, eventId, lineTotal, grossMap);
      }
    }
  }

  // 4. If no photographers were attributed (degenerate order), fall back fully.
  if (grossMap.size === 0) {
    await attributeViaFallback(db, eventId, grossG, grossMap);
  }

  // 5. Normalise: attributed gross must sum exactly to G via allocateProportional.
  //    This corrects any floating-point drift from multi-step attribution above.
  const photographerIds = [...grossMap.keys()];
  const grossWeights = photographerIds.map((uid) => grossMap.get(uid) ?? 0);
  const normalisedGross = allocateProportional(grossG, grossWeights);

  // 6. Compute fees on gross G and split distributable across photographers
  //    weighted by their normalised gross share.
  const platformFeeCents = estimatePlatformFeeCents(grossG);
  const stripeFeeCents = estimateStripeFeeCents(grossG);
  const distributableCents = grossG - platformFeeCents - stripeFeeCents;

  if (distributableCents <= 0) {
    throw new Error(
      `order-split: distributable is non-positive for order ${orderId}: ${distributableCents}`,
    );
  }

  const netAmounts = allocateProportional(distributableCents, normalisedGross);

  // 7. Resolve account ids.
  const cashAccountId = await getPlatformAccountId(db, 'platform_cash');
  const stripeFeeAccountId = await getPlatformAccountId(db, 'stripe_fee');
  const platformRevenueAccountId = await getPlatformAccountId(db, 'platform_revenue');

  const entries: LedgerEntryInput[] = [];

  // DEBIT platform_cash G (kind='sale').
  entries.push({
    accountId: cashAccountId,
    direction: 'debit',
    amountCents: grossG,
    currency,
    kind: 'sale',
    memo: `order ${orderId} gross receipt`,
    orderId,
  });

  // CREDIT stripe_fee S (kind='stripe_fee').
  entries.push({
    accountId: stripeFeeAccountId,
    direction: 'credit',
    amountCents: stripeFeeCents,
    currency,
    kind: 'stripe_fee',
    memo: `order ${orderId} stripe processing fee`,
    orderId,
  });

  // CREDIT platform_revenue P (kind='platform_fee').
  entries.push({
    accountId: platformRevenueAccountId,
    direction: 'credit',
    amountCents: platformFeeCents,
    currency,
    kind: 'platform_fee',
    memo: `order ${orderId} platform fee`,
    orderId,
  });

  // CREDIT photographer_i N_i (kind='sale') — ONE aggregated entry per photographer.
  const photographerNetByUserId: Record<string, number> = {};

  for (let i = 0; i < photographerIds.length; i += 1) {
    const uid = photographerIds[i];
    const net = netAmounts[i];
    if (!uid || net === undefined || net <= 0) continue;

    const accountId = await ensurePhotographerAccount(db, uid);
    entries.push({
      accountId,
      direction: 'credit',
      amountCents: net,
      currency,
      kind: 'sale',
      memo: `order ${orderId} sale net to photographer ${uid}`,
      orderId,
    });
    photographerNetByUserId[uid] = net;
  }

  // 8. Defensive balance check before returning.
  assertBalanced(entries);

  return {
    entries,
    totalCents: grossG,
    platformFeeCents,
    stripeFeeCents,
    photographerNetByUserId,
  };
};

// ---------- Public write surface ----------

// Idempotent: postLedgerBatch deduplicates by (orderId, kind, accountId, direction).
// Safe to call on webhook replay.
export const recordOrderSale = async (db: DbClient, orderId: string): Promise<void> => {
  const result = await computeOrderSplit(db, orderId);
  await postLedgerBatch(db, result.entries);
};
