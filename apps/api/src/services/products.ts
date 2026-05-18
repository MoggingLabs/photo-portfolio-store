// Products service layer. Pure functions over DbClient — no Fastify or HTTP
// concerns leak in here. M1 ships only kind='digital_single' (one product per
// photo + license tier); the schema accommodates digital_bundle / foto_flat /
// print for M2/M4 without enum migration.
//
// Authorization (org / event-member scope) is enforced at the route layer via
// app.requirePermission; this service trusts its callers to have done that.
// Cross-context validation (photo belongs to event, license tier exists) IS
// enforced here because those invariants are semantic, not authorization.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';

import { type CursorPayload, decodeCursor, encodeCursor } from '../lib/cursor.js';
import { LICENSE_TIER_SEED, LICENSE_TIER_SKU_CODE } from '../lib/license-tiers.js';

const { products, licenseTiers } = schema.catalog.tables;
const { photos } = schema.photos.tables;
const { auditLog } = schema.compliance.tables;

// ---------- Types ----------

export type ProductKind = 'digital_single' | 'digital_bundle' | 'foto_flat' | 'print';

export interface ListProductsInput {
  eventId: string;
  kind?: ProductKind;
  active?: boolean;
  cursor?: string;
  limit?: number;
}

export interface ListProductsResult {
  products: Array<typeof products.$inferSelect>;
  nextCursor: string | null;
}

export interface CreateProductInput {
  eventId: string;
  photoId: string;
  licenseTierId: string;
  name: string;
  priceCents: number;
  currency: string;
  description?: string;
}

export interface UpdateProductInput {
  name?: string;
  priceCents?: number;
  currency?: string;
  description?: string | null;
  licenseTierId?: string;
}

// ---------- Errors ----------

export class ProductServiceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'conflict' | 'invalid' | 'unprocessable' | 'forbidden',
    message: string,
  ) {
    super(message);
    this.name = 'ProductServiceError';
  }
}

// ---------- Helpers ----------

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

const clampLimit = (raw: number | undefined): number => {
  if (!raw || raw < 1) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
};

const writeAudit = async (
  db: DbClient,
  args: {
    actorUserId: string;
    action: string;
    productId: string;
    eventId: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> => {
  await db.insert(auditLog).values({
    actorUserId: args.actorUserId,
    actorKind: 'user',
    action: args.action,
    targetKind: 'product',
    targetId: args.productId,
    eventId: args.eventId,
    payloadJsonb: args.payload ?? null,
  });
};

// Deterministic SKU generator. Same inputs always yield the same SKU; the
// unique constraint `products_sku_unique` catches duplicate calls. Format:
//   evt-<event8>-photo-<photo8>-<licCode>
const generateSku = (eventId: string, photoId: string, licenseCode: string): string => {
  const shortEvent = eventId.replace(/-/g, '').slice(0, 8);
  const shortPhoto = photoId.replace(/-/g, '').slice(0, 8);
  const lic = LICENSE_TIER_SKU_CODE[licenseCode] ?? licenseCode.slice(0, 3);
  return `evt-${shortEvent}-photo-${shortPhoto}-${lic}`;
};

// ---------- License tier helpers ----------

export const getLicenseTierByCode = async (
  db: DbClient,
  code: string,
): Promise<typeof licenseTiers.$inferSelect | null> => {
  const rows = await db.select().from(licenseTiers).where(eq(licenseTiers.code, code)).limit(1);
  return rows[0] ?? null;
};

export const getLicenseTierById = async (
  db: DbClient,
  id: string,
): Promise<typeof licenseTiers.$inferSelect | null> => {
  const rows = await db.select().from(licenseTiers).where(eq(licenseTiers.id, id)).limit(1);
  return rows[0] ?? null;
};

// Idempotent: inserts every tier from LICENSE_TIER_SEED that is not already
// present (by `code`). Safe to call repeatedly at API boot. Returns the count
// of newly inserted tiers.
export const seedDefaultLicenseTiers = async (db: DbClient): Promise<number> => {
  const existing = await db.select({ code: licenseTiers.code }).from(licenseTiers);
  const have = new Set(existing.map((r) => r.code));
  const missing = LICENSE_TIER_SEED.filter((t) => !have.has(t.code));
  if (missing.length === 0) return 0;
  await db.insert(licenseTiers).values(
    missing.map((t) => ({
      code: t.code,
      name: t.name,
      description: t.description,
      sortOrder: t.sortOrder,
    })),
  );
  return missing.length;
};

// ---------- Operations ----------

export const listProducts = async (
  db: DbClient,
  input: ListProductsInput,
): Promise<ListProductsResult> => {
  const limit = clampLimit(input.limit);
  const cursor: CursorPayload | null = decodeCursor(input.cursor);

  const filters = [eq(products.eventId, input.eventId)];
  if (input.kind) filters.push(eq(products.kind, input.kind));
  if (input.active !== undefined) filters.push(eq(products.active, input.active));
  if (cursor) {
    const cond = or(
      lt(products.createdAt, cursor.createdAt),
      and(eq(products.createdAt, cursor.createdAt), lt(products.id, cursor.id)),
    );
    if (cond) filters.push(cond);
  }

  const rows = await db
    .select()
    .from(products)
    .where(and(...filters))
    .orderBy(desc(products.createdAt), desc(products.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const last = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ id: last.id, createdAt: last.createdAt }) : null;

  return { products: trimmed, nextCursor };
};

export const getProduct = async (
  db: DbClient,
  productId: string,
): Promise<typeof products.$inferSelect | null> => {
  const rows = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  return rows[0] ?? null;
};

// M1: only kind='digital_single'. Validates that the photo exists and belongs
// to the same event, and that the license tier exists. Audit logs
// product.created on success.
export const createProduct = async (
  db: DbClient,
  input: CreateProductInput,
  actorUserId: string,
): Promise<typeof products.$inferSelect> => {
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw new ProductServiceError('invalid', 'priceCents must be a non-negative integer');
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new ProductServiceError('invalid', 'currency must be a 3-letter ISO 4217 code');
  }

  // Validate photo exists AND belongs to the same event.
  const photoRows = await db
    .select({ id: photos.id, eventId: photos.eventId })
    .from(photos)
    .where(eq(photos.id, input.photoId))
    .limit(1);
  const photo = photoRows[0];
  if (!photo) {
    throw new ProductServiceError('unprocessable', 'photo not found');
  }
  if (photo.eventId !== input.eventId) {
    throw new ProductServiceError('unprocessable', 'photo does not belong to the target event');
  }

  // Validate license tier exists; also need its code for the SKU.
  const tier = await getLicenseTierById(db, input.licenseTierId);
  if (!tier) {
    throw new ProductServiceError('unprocessable', 'license tier not found');
  }

  const sku = generateSku(input.eventId, input.photoId, tier.code);

  // Pre-check unique (event, photo, kind, license) combo so we can return a
  // clean 409 instead of relying on a raw DB error.
  const duplicate = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.eventId, input.eventId),
        eq(products.photoId, input.photoId),
        eq(products.kind, 'digital_single'),
        eq(products.licenseTierId, input.licenseTierId),
      ),
    )
    .limit(1);
  if (duplicate.length > 0) {
    throw new ProductServiceError(
      'conflict',
      'product already exists for this (event, photo, license tier)',
    );
  }

  const inserted = await db
    .insert(products)
    .values({
      eventId: input.eventId,
      kind: 'digital_single',
      sku,
      name: input.name,
      description: input.description ?? null,
      priceCents: input.priceCents,
      currency: input.currency,
      licenseTierId: input.licenseTierId,
      photoId: input.photoId,
      configJsonb: {},
      active: true,
    })
    .returning();

  const row = inserted[0];
  if (!row) {
    throw new ProductServiceError('invalid', 'insert returned no row');
  }

  await writeAudit(db, {
    actorUserId,
    action: 'product.created',
    productId: row.id,
    eventId: row.eventId,
    payload: { sku, kind: row.kind, licenseTierId: row.licenseTierId, photoId: row.photoId },
  });

  return row;
};

// Partial update. Cannot change `kind` or `eventId` (those are immutable for
// the lifetime of a SKU — changing them would invalidate snapshots already
// captured by order_items). The route layer rejects those fields up front;
// this layer rejects anything that gets through.
export const updateProduct = async (
  db: DbClient,
  productId: string,
  patch: UpdateProductInput,
  actorUserId: string,
): Promise<typeof products.$inferSelect> => {
  const current = await getProduct(db, productId);
  if (!current) {
    throw new ProductServiceError('not_found', 'product not found');
  }

  if (patch.priceCents !== undefined) {
    if (!Number.isInteger(patch.priceCents) || patch.priceCents < 0) {
      throw new ProductServiceError('invalid', 'priceCents must be a non-negative integer');
    }
  }
  if (patch.currency !== undefined && !/^[A-Z]{3}$/.test(patch.currency)) {
    throw new ProductServiceError('invalid', 'currency must be a 3-letter ISO 4217 code');
  }
  if (patch.licenseTierId !== undefined) {
    const tier = await getLicenseTierById(db, patch.licenseTierId);
    if (!tier) {
      throw new ProductServiceError('unprocessable', 'license tier not found');
    }
  }

  const updated = await db
    .update(products)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.priceCents !== undefined ? { priceCents: patch.priceCents } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.licenseTierId !== undefined ? { licenseTierId: patch.licenseTierId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(products.id, productId))
    .returning();

  const next = updated[0];
  if (!next) {
    throw new ProductServiceError('not_found', 'product vanished mid-update');
  }

  await writeAudit(db, {
    actorUserId,
    action: 'product.updated',
    productId: next.id,
    eventId: next.eventId,
    payload: { patch },
  });

  return next;
};

// Soft deactivate. We never hard-delete because order_items keep snapshots
// of products at purchase time, but historical reads (admin dashboards,
// refund flows) still join back to the product row.
export const deactivateProduct = async (
  db: DbClient,
  productId: string,
  actorUserId: string,
): Promise<typeof products.$inferSelect> => {
  const current = await getProduct(db, productId);
  if (!current) {
    throw new ProductServiceError('not_found', 'product not found');
  }

  // Idempotent: if already inactive, return as-is without re-writing audit.
  if (!current.active) {
    return current;
  }

  const updated = await db
    .update(products)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(products.id, productId))
    .returning();

  const next = updated[0];
  if (!next) {
    throw new ProductServiceError('not_found', 'product vanished mid-deactivate');
  }

  await writeAudit(db, {
    actorUserId,
    action: 'product.deactivated',
    productId: next.id,
    eventId: next.eventId,
  });

  return next;
};

// Cross-context helper — looks up an event row to determine its orgId. Used
// by the route layer for permission scoping and public-access decisions.
export const getProductEvent = async (
  db: DbClient,
  eventId: string,
): Promise<{ id: string; orgId: string; status: string } | null> => {
  const events = schema.events.tables.events;
  const rows = await db
    .select({ id: events.id, orgId: events.orgId, status: events.status })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, orgId: row.orgId, status: row.status };
};

// Re-export for convenience so route handlers don't have to import the seed
// constant separately when they want to list available tier codes.
export { LICENSE_TIER_SEED };

// Marker: keep sql import alive for future query expansion (e.g. partial
// index hints). Avoids a stray lint warning when the import is otherwise
// only referenced through drizzle helpers.
void sql;
