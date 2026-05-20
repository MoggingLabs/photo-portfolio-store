// Pricing tier service. Resolves license-tier multipliers from pricing_rules
// (kind='tier_uplift') and exposes a deterministic unit-price computation.
//
// Resolution precedence for resolveTierMultiplier:
//   1. Event-scoped tier_uplift rule (pricing_rule_targets.targetType='event',
//      targetId=eventId) — highest specificity.
//   2. Global tier_uplift rule (scope='global', no target row required).
//   3. DEFAULT_TIER_MULTIPLIERS[tierCode] — compile-time fallback.
//   4. 1 (identity) — final fallback when code is unknown.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, desc, eq } from 'drizzle-orm';

const { licenseTiers, pricingRules, pricingRuleTargets } = schema.catalog.tables;

// ---------- Constants ----------

// Sensible default multipliers applied when no pricing_rule of kind='tier_uplift'
// is found for the given tier. Deployers can override per-event via the
// pricing_rules + pricing_rule_targets tables without redeploying.
export const DEFAULT_TIER_MULTIPLIERS: Readonly<Record<string, number>> = {
  personal: 1,
  social: 1.5,
  editorial: 2,
  commercial: 3,
};

// ---------- Types ----------

export interface TierView {
  id: string;
  code: string;
  label: string;
  multiplier: number;
  scopeDescription: string;
}

// ---------- Errors ----------

export class PricingTierError extends Error {
  constructor(
    public readonly code: 'unknown_tier' | 'tier_immutable',
    message: string,
  ) {
    super(message);
    this.name = 'PricingTierError';
  }
}

// ---------- Helpers ----------

interface TierUpliftParams {
  tierCode: string;
  multiplier: number;
}

const isTierUpliftParams = (v: unknown): v is TierUpliftParams =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Record<string, unknown>).tierCode === 'string' &&
  typeof (v as Record<string, unknown>).multiplier === 'number';

// Returns the active tier_uplift rule multiplier for a specific tier code,
// or null if no matching active rule exists in the provided rows.
const extractMultiplierFromRows = (
  rows: Array<{ params: unknown; scope: string }>,
  tierCode: string,
): number | null => {
  for (const row of rows) {
    const params = row.params;
    if (isTierUpliftParams(params) && params.tierCode === tierCode) {
      return params.multiplier;
    }
  }
  return null;
};

// ---------- Service functions ----------

export async function listTiers(db: DbClient, opts?: { eventId?: string }): Promise<TierView[]> {
  const tierRows = await db.select().from(licenseTiers).orderBy(licenseTiers.sortOrder);

  const results: TierView[] = [];
  for (const tier of tierRows) {
    const multiplier = await resolveTierMultiplier(db, {
      eventId: opts?.eventId,
      tierCode: tier.code,
    });
    results.push({
      id: tier.id,
      code: tier.code,
      label: tier.name,
      multiplier,
      scopeDescription: tier.description,
    });
  }
  return results;
}

export async function resolveTierMultiplier(
  db: DbClient,
  params: { eventId?: string; tierCode: string },
): Promise<number> {
  const { eventId, tierCode } = params;

  // Step 1: event-scoped tier_uplift rule (highest precedence).
  // An event-scoped rule is joined via pricing_rule_targets with targetType='event'.
  // Time-window enforcement (startsAt/endsAt) is deferred to the F2.5 full
  // pricing evaluator; the `active` boolean is the gate for this milestone.
  if (eventId) {
    const eventScopedRows = await db
      .select({
        params: pricingRules.params,
        scope: pricingRules.scope,
        priority: pricingRules.priority,
      })
      .from(pricingRules)
      .innerJoin(pricingRuleTargets, eq(pricingRuleTargets.ruleId, pricingRules.id))
      .where(
        and(
          eq(pricingRules.kind, 'tier_uplift'),
          eq(pricingRules.active, true),
          eq(pricingRuleTargets.targetType, 'event'),
          eq(pricingRuleTargets.targetId, eventId),
        ),
      )
      .orderBy(desc(pricingRules.priority));

    const eventMultiplier = extractMultiplierFromRows(eventScopedRows, tierCode);
    if (eventMultiplier !== null) return eventMultiplier;
  }

  // Step 2: global tier_uplift rule (scope='global', no target row required).
  const globalRows = await db
    .select({
      params: pricingRules.params,
      scope: pricingRules.scope,
      priority: pricingRules.priority,
    })
    .from(pricingRules)
    .where(
      and(
        eq(pricingRules.kind, 'tier_uplift'),
        eq(pricingRules.active, true),
        eq(pricingRules.scope, 'global'),
      ),
    )
    .orderBy(desc(pricingRules.priority));

  const globalMultiplier = extractMultiplierFromRows(globalRows, tierCode);
  if (globalMultiplier !== null) return globalMultiplier;

  // Step 3: compile-time default.
  const defaultMultiplier = DEFAULT_TIER_MULTIPLIERS[tierCode];
  if (defaultMultiplier !== undefined) return defaultMultiplier;

  // Step 4: identity fallback for unknown tier codes.
  return 1;
}

export function applyTierMultiplier(baseCents: number, multiplier: number): number {
  return Math.round(baseCents * multiplier);
}

// Guard for order-mutation paths. Call this before allowing any change to
// the license tier on an already-placed order. Orders are immutable snapshots:
// once placed, the tier is locked.
//
// WIRING: Call assertTierMutable from any order-update endpoint introduced in
// M2+ (e.g. admin order correction). No such endpoint exists in M1/M2 carts.ts
// — the natural wiring point is a hypothetical PATCH /v1/orders/:id handler.
export function assertTierMutable(currentTierCode: string, requestedTierCode: string): void {
  if (currentTierCode !== requestedTierCode) {
    throw new PricingTierError(
      'tier_immutable',
      `License tier cannot be changed on a placed order (current: ${currentTierCode}, requested: ${requestedTierCode})`,
    );
  }
}
