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
  primaryKey,
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

// ---------- bundles ----------
// A bundle groups one or more photos for sale as a unit. The selector jsonb
// document describes what is in the bundle by kind:
//   kind='bib'       => selector = { "bib": "<bib_value>" }
//   kind='foto_flat' => selector = { "all": true }
//   kind='custom'    => selector = { "photoIds": ["<uuid>", ...] }
// base_price_cents is the list price before any pricing rule is applied.

export const bundleKind = app.enum('bundle_kind', ['bib', 'foto_flat', 'custom']);

export const bundles = app.table(
  'bundles',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs events.id — cross-context, no FK.
    eventId: uuid('event_id').notNull(),
    kind: bundleKind('kind').notNull(),
    // Shape depends on kind; see table comment above.
    selector: jsonb('selector').notNull().default(sql`'{}'::jsonb`),
    basePriceCents: integer('base_price_cents').notNull(),
    currency: text('currency').notNull(),
    // Same-file FK; license_tiers is seed data and safe to reference.
    // NOTE: spec draft said `license_tier text` but established codebase
    // pattern (products, cart_items, order_items) uses license_tier_id uuid.
    // Using uuid FK here for consistency.
    licenseTierId: uuid('license_tier_id')
      .notNull()
      .references(() => licenseTiers.id),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    eventActiveIdx: index('bundles_event_active_idx').on(table.eventId, table.active),
  }),
);

// ---------- bundle_items ----------
// Materialized bundle membership. Each row pins one photo to a bundle.
// Cascade delete keeps membership in sync when a bundle is removed.

export const bundleItems = app.table(
  'bundle_items',
  {
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => bundles.id, { onDelete: 'cascade' }),
    // refs photos.id — cross-context, no FK.
    photoId: uuid('photo_id').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.bundleId, table.photoId] }),
  }),
);

// ---------- pricing_rules ----------
// Flexible rule engine for discounts and uplifts. params shape by kind:
//   tier_uplift  => { "tierCode": "commercial", "multiplier": 2.5 }
//   qty_discount => { "minQty": 5, "pct": 0.1 }
//   time_window  => { "pct": 0.15 }  (bounds via starts_at / ends_at)
//   pre_event    => { "pct": 0.20 }
// Higher priority wins when multiple rules match.

export const pricingRuleScope = app.enum('pricing_rule_scope', [
  'global',
  'event',
  'bundle',
  'photographer',
]);

export const pricingRuleKind = app.enum('pricing_rule_kind', [
  'qty_discount',
  'time_window',
  'pre_event',
  'tier_uplift',
]);

export const pricingRules = app.table(
  'pricing_rules',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    scope: pricingRuleScope('scope').notNull(),
    kind: pricingRuleKind('kind').notNull(),
    params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
    // Higher value = evaluated first when multiple rules match.
    priority: integer('priority').notNull().default(0),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    scopeActiveIdx: index('pricing_rules_scope_active_idx').on(
      table.scope,
      table.active,
      table.startsAt,
      table.endsAt,
    ),
  }),
);

// ---------- pricing_rule_targets ----------
// Associates a pricing rule with a specific entity (event, bundle, photographer,
// license tier). target_type drives dispatch in application code.

export const pricingRuleTargets = app.table(
  'pricing_rule_targets',
  {
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => pricingRules.id, { onDelete: 'cascade' }),
    // 'event' | 'bundle' | 'photographer' | 'tier'
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.ruleId, table.targetType, table.targetId] }),
    targetIdx: index('pricing_rule_targets_target_idx').on(table.targetType, table.targetId),
  }),
);

// ---------- Grouped export ----------

export const tables = {
  licenseTiers,
  products,
  bundles,
  bundleItems,
  pricingRules,
  pricingRuleTargets,
};
