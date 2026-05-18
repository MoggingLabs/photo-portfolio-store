// Catalog context — products and license tiers.
// All tables in the Postgres `app` schema. Cross-context FKs stay as plain
// uuid columns; application code enforces. M1 ships digital_single products
// only; the kind enum already accommodates M2 bundle/foto-flat variants.

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');

// ---------- Enums ----------

export const productKind = app.enum('product_kind', [
  'digital_single',
  'digital_bundle',
  'foto_flat',
  'print',
]);

// ---------- license_tiers ----------
// Small lookup table seeded by app code on bootstrap. Codes are stable
// identifiers ('personal', 'social', 'editorial', 'commercial'); name and
// description are human-facing copy editable per deployment.

export const licenseTiers = app.table(
  'license_tiers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // One of 'personal', 'social', 'editorial', 'commercial'. Modeled as text
    // (not pgEnum) so deployments can add tiers without a schema migration.
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    // UI ordering — lower sorts first.
    sortOrder: integer('sort_order').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    codeUnique: uniqueIndex('license_tiers_code_unique').on(table.code),
  }),
);

// ---------- products ----------
// M1 ships only kind='digital_single' (one product per (photo, license_tier)).
// The enum already includes digital_bundle / foto_flat / print so M2/M4 do
// not require an enum migration. config_jsonb is the escape hatch for the
// variant-specific knobs (print size, bundle rules, etc.).

export const products = app.table(
  'products',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs events.id — cross-context, no FK to avoid coupling schema files.
    eventId: uuid('event_id').notNull(),
    kind: productKind('kind').notNull(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    // Smallest currency unit (e.g. USD cents, BRL centavos).
    priceCents: integer('price_cents').notNull(),
    // ISO 4217 — denormalized from event for query speed.
    currency: text('currency').notNull(),
    // Same-file FK is fine; license tiers are seed data and not deleted while
    // referenced by live products.
    licenseTierId: uuid('license_tier_id')
      .notNull()
      .references(() => licenseTiers.id),
    // Free-form variant config: print size, paper type, bundle rules, etc.
    configJsonb: jsonb('config_jsonb').notNull().default(sql`'{}'::jsonb`),
    // refs photos.id — cross-context, no FK. Populated only for
    // kind='digital_single'; null for bundles / foto-flat / print SKUs.
    photoId: uuid('photo_id'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    // App code updates updated_at on change.
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    skuUnique: uniqueIndex('products_sku_unique').on(table.sku),
    // Storefront catalog listing: active products in an event, by kind.
    eventKindActiveIdx: index('products_event_kind_active_idx').on(
      table.eventId,
      table.kind,
      table.active,
    ),
    // "Find product(s) for this photo" — partial index keeps it small since
    // only digital_single rows populate photo_id.
    photoIdx: index('products_photo_idx')
      .on(table.photoId)
      .where(sql`${table.photoId} is not null`),
    // Prevents duplicate single-photo products for the same
    // (event, photo, kind, license) combination.
    eventPhotoKindLicenseUnique: uniqueIndex('products_event_photo_kind_license_unique').on(
      table.eventId,
      table.photoId,
      table.kind,
      table.licenseTierId,
    ),
  }),
);

// ---------- Grouped export ----------

export const tables = {
  licenseTiers,
  products,
};
