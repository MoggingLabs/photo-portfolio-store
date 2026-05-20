// Unit tests for apps/api/src/services/pricing-tiers.ts.
// All DB calls are mocked via a minimal in-memory store; no real Postgres.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Types ----------

type Row = Record<string, unknown>;

interface Store {
  licenseTiers: Row[];
  pricingRules: Row[];
  pricingRuleTargets: Row[];
}

const newStore = (): Store => ({
  licenseTiers: [],
  pricingRules: [],
  pricingRuleTargets: [],
});

const TABLE_KEY = Symbol('table-key');

const tableMarker = (key: keyof Store): Row => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

let uuidCounter = 0;
const fakeUuid = (): string => {
  uuidCounter += 1;
  const n = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
};

// ---------- Mocks ----------

vi.mock('@pkg/db', () => {
  const catalogTables = {
    licenseTiers: tableMarker('licenseTiers'),
    pricingRules: tableMarker('pricingRules'),
    pricingRuleTargets: tableMarker('pricingRuleTargets'),
    products: tableMarker('licenseTiers'),
    bundles: tableMarker('licenseTiers'),
    bundleItems: tableMarker('licenseTiers'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      catalog: { tables: catalogTables },
      commerce: { tables: {} },
      photos: { tables: {} },
      events: { tables: {} },
      compliance: { tables: {} },
    },
  };
});

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: {
    object: () => ({
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    }),
    string: () => ({ min: () => ({}) }),
  },
}));

// ---------- Mock drizzle-orm ----------

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[(v as Field).column] : v);

  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  const desc = (field: Field) => (a: Row, b: Row) => {
    const av = a[field.column];
    const bv = b[field.column];
    if (av instanceof Date && bv instanceof Date) return bv.getTime() - av.getTime();
    return (av as number) > (bv as number) ? -1 : (av as number) < (bv as number) ? 1 : 0;
  };
  const sqlTag = ((_strings: TemplateStringsArray) => ({ __sql: '' })) as unknown as Record<
    string,
    unknown
  >;
  return { eq, and, desc, sql: sqlTag };
});

// ---------- Fake DB builder ----------

let store: Store = newStore();

const makeFakeDb = (): unknown => {
  const runSelect = (
    bucket: keyof Store,
    filterFn: (r: Row) => boolean,
    sortFn?: (a: Row, b: Row) => number,
    limit?: number,
  ): Row[] => {
    let rows = store[bucket].filter(filterFn);
    if (sortFn) rows = [...rows].sort(sortFn);
    if (limit !== undefined) rows = rows.slice(0, limit);
    return rows.map((r) => ({ ...r }));
  };

  const selectBuilder = (_selection?: Record<string, unknown>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let sortFn: ((a: Row, b: Row) => number) | undefined;
    let limitN: number | undefined;
    // For innerJoin support: we track secondary join tables and merge row data
    let joinBucket: keyof Store | null = null;
    let joinOnFn: ((mergedRow: Row) => boolean) | null = null;

    const api = {
      from(table: Row) {
        bucket = table[TABLE_KEY] as keyof Store;
        return api;
      },
      // drizzle innerJoin receives the join ON expression which is a predicate
      // over a merged row (e.g. eq(t1.col, t2.col) returns (row) => bool).
      innerJoin(table: Row, on: (mergedRow: Row) => boolean) {
        joinBucket = table[TABLE_KEY] as keyof Store;
        joinOnFn = on;
        return api;
      },
      where(predicate: (r: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      // drizzle .orderBy accepts either comparator functions (e.g. desc(col))
      // or a raw column Field for ascending order (e.g. orderBy(table.col)).
      orderBy(...args: Array<((a: Row, b: Row) => number) | { column: string }>) {
        const comparators = args.map((arg) => {
          if (typeof arg === 'function') return arg;
          const col = arg.column;
          return (a: Row, b: Row) => {
            const av = a[col] as number | string;
            const bv = b[col] as number | string;
            return av > bv ? 1 : av < bv ? -1 : 0;
          };
        });
        sortFn = (a, b) => {
          for (const c of comparators) {
            const v = c(a, b);
            if (v !== 0) return v;
          }
          return 0;
        };
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) {
        try {
          if (!bucket) return resolve([]);
          const filterFn = (r: Row) => filters.every((f) => f(r));
          let rows: Row[];
          if (joinBucket && joinOnFn) {
            // Cross-join then filter: apply the ON predicate and WHERE filters
            // on the merged row (columns from both tables are available).
            const primaryRows = store[bucket];
            const secondaryRows = store[joinBucket];
            rows = primaryRows
              .flatMap((primary) =>
                secondaryRows
                  .map((secondary) => ({ ...secondary, ...primary }))
                  .filter((merged) => joinOnFn!(merged)),
              )
              .filter(filterFn);
          } else {
            rows = runSelect(bucket, filterFn, sortFn, limitN);
          }
          if (sortFn) rows = [...rows].sort(sortFn);
          if (limitN !== undefined) rows = rows.slice(0, limitN);
          return resolve(rows.map((r) => ({ ...r })));
        } catch (e) {
          return reject(e);
        }
      },
    };
    return api;
  };

  const insertBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let toInsert: Row[] = [];
    const api = {
      values(payload: Row | Row[]) {
        const arr = Array.isArray(payload) ? payload : [payload];
        toInsert = arr.map((row) => ({
          id: fakeUuid(),
          createdAt: new Date(),
          ...row,
        }));
        store[bucket].push(...toInsert.map((r) => ({ ...r })));
        return api;
      },
      returning() {
        return api as unknown as Promise<Row[]>;
      },
      then(resolve: (v: Row[]) => unknown) {
        return resolve(toInsert.map((r) => ({ ...r })));
      },
    };
    return api;
  };

  return {
    select: (selection?: Record<string, unknown>) => selectBuilder(selection),
    insert: (table: Row) => insertBuilder(table),
  };
};

// ---------- Field shims ----------

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tierTbl = schema.catalog.tables.licenseTiers as Record<string, unknown>;
  const ruleTbl = schema.catalog.tables.pricingRules as Record<string, unknown>;
  const targetTbl = schema.catalog.tables.pricingRuleTargets as Record<string, unknown>;

  for (const col of ['id', 'code', 'name', 'description', 'sortOrder', 'createdAt']) {
    tierTbl[col] = { column: col };
  }
  for (const col of [
    'id',
    'scope',
    'kind',
    'params',
    'priority',
    'startsAt',
    'endsAt',
    'active',
    'createdAt',
  ]) {
    ruleTbl[col] = { column: col };
  }
  for (const col of ['ruleId', 'targetType', 'targetId']) {
    targetTbl[col] = { column: col };
  }
};

// ---------- Lifecycle ----------

let db: ReturnType<typeof makeFakeDb>;

const TIER_PERSONAL_ID = '00000000-0000-4000-8000-000000000001';
const TIER_SOCIAL_ID = '00000000-0000-4000-8000-000000000002';
const TIER_EDITORIAL_ID = '00000000-0000-4000-8000-000000000003';
const TIER_COMMERCIAL_ID = '00000000-0000-4000-8000-000000000004';
const EVENT_ID = '00000000-0000-4000-8000-0000000000aa';
const RULE_GLOBAL_ID = '00000000-0000-4000-8000-000000000010';
const RULE_EVENT_ID = '00000000-0000-4000-8000-000000000011';

const seedTiers = (): void => {
  store.licenseTiers = [
    {
      id: TIER_PERSONAL_ID,
      code: 'personal',
      name: 'Personal use',
      description: 'Private use',
      sortOrder: 1,
    },
    {
      id: TIER_SOCIAL_ID,
      code: 'social',
      name: 'Social media',
      description: 'Social posts',
      sortOrder: 2,
    },
    {
      id: TIER_EDITORIAL_ID,
      code: 'editorial',
      name: 'Editorial',
      description: 'News articles',
      sortOrder: 3,
    },
    {
      id: TIER_COMMERCIAL_ID,
      code: 'commercial',
      name: 'Commercial',
      description: 'Full commercial',
      sortOrder: 4,
    },
  ];
};

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  await installFieldShims();
  db = makeFakeDb();
});

// ---------- applyTierMultiplier ----------

describe('applyTierMultiplier', () => {
  it('rounds up correctly', async () => {
    const { applyTierMultiplier } = await import('../src/services/pricing-tiers.js');
    expect(applyTierMultiplier(1000, 1.5)).toBe(1500);
    expect(applyTierMultiplier(1001, 1.5)).toBe(1502); // Math.round(1501.5) = 1502
    expect(applyTierMultiplier(100, 3)).toBe(300);
    expect(applyTierMultiplier(0, 2)).toBe(0);
  });

  it('handles identity multiplier', async () => {
    const { applyTierMultiplier } = await import('../src/services/pricing-tiers.js');
    expect(applyTierMultiplier(9999, 1)).toBe(9999);
  });

  it('returns integer cents (never a float)', async () => {
    const { applyTierMultiplier } = await import('../src/services/pricing-tiers.js');
    const result = applyTierMultiplier(1000, 1.5);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ---------- DEFAULT_TIER_MULTIPLIERS ----------

describe('DEFAULT_TIER_MULTIPLIERS', () => {
  it('has the four canonical tiers', async () => {
    const { DEFAULT_TIER_MULTIPLIERS } = await import('../src/services/pricing-tiers.js');
    expect(DEFAULT_TIER_MULTIPLIERS.personal).toBe(1);
    expect(DEFAULT_TIER_MULTIPLIERS.social).toBe(1.5);
    expect(DEFAULT_TIER_MULTIPLIERS.editorial).toBe(2);
    expect(DEFAULT_TIER_MULTIPLIERS.commercial).toBe(3);
  });
});

// ---------- resolveTierMultiplier ----------

describe('resolveTierMultiplier', () => {
  it('returns default when no pricing rules exist', async () => {
    const { resolveTierMultiplier } = await import('../src/services/pricing-tiers.js');
    const mult = await resolveTierMultiplier(db as never, { tierCode: 'commercial' });
    expect(mult).toBe(3);
  });

  it('returns 1 for unknown tier code (final fallback)', async () => {
    const { resolveTierMultiplier } = await import('../src/services/pricing-tiers.js');
    const mult = await resolveTierMultiplier(db as never, { tierCode: 'unknown_tier' });
    expect(mult).toBe(1);
  });

  it('prefers global rule over default', async () => {
    const { resolveTierMultiplier } = await import('../src/services/pricing-tiers.js');
    store.pricingRules.push({
      id: RULE_GLOBAL_ID,
      scope: 'global',
      kind: 'tier_uplift',
      params: { tierCode: 'commercial', multiplier: 4 },
      priority: 0,
      active: true,
    });

    const mult = await resolveTierMultiplier(db as never, { tierCode: 'commercial' });
    expect(mult).toBe(4);
  });

  it('prefers event-scoped rule over global rule', async () => {
    const { resolveTierMultiplier } = await import('../src/services/pricing-tiers.js');
    // Global rule
    store.pricingRules.push({
      id: RULE_GLOBAL_ID,
      scope: 'global',
      kind: 'tier_uplift',
      params: { tierCode: 'commercial', multiplier: 4 },
      priority: 0,
      active: true,
    });
    // Event-scoped rule
    store.pricingRules.push({
      id: RULE_EVENT_ID,
      scope: 'event',
      kind: 'tier_uplift',
      params: { tierCode: 'commercial', multiplier: 2.5 },
      priority: 10,
      active: true,
    });
    store.pricingRuleTargets.push({
      ruleId: RULE_EVENT_ID,
      targetType: 'event',
      targetId: EVENT_ID,
    });

    const mult = await resolveTierMultiplier(db as never, {
      eventId: EVENT_ID,
      tierCode: 'commercial',
    });
    expect(mult).toBe(2.5);
  });

  it('falls back to global rule when event has no matching rule', async () => {
    const { resolveTierMultiplier } = await import('../src/services/pricing-tiers.js');
    store.pricingRules.push({
      id: RULE_GLOBAL_ID,
      scope: 'global',
      kind: 'tier_uplift',
      params: { tierCode: 'social', multiplier: 1.8 },
      priority: 0,
      active: true,
    });

    const mult = await resolveTierMultiplier(db as never, {
      eventId: EVENT_ID, // no event rule exists
      tierCode: 'social',
    });
    expect(mult).toBe(1.8);
  });

  it('ignores inactive rules', async () => {
    const { resolveTierMultiplier } = await import('../src/services/pricing-tiers.js');
    store.pricingRules.push({
      id: RULE_GLOBAL_ID,
      scope: 'global',
      kind: 'tier_uplift',
      params: { tierCode: 'personal', multiplier: 5 },
      priority: 0,
      active: false, // inactive
    });

    const mult = await resolveTierMultiplier(db as never, { tierCode: 'personal' });
    // Should fall back to default since rule is inactive
    expect(mult).toBe(1);
  });

  it('does not apply event rule for a different tier code', async () => {
    const { resolveTierMultiplier } = await import('../src/services/pricing-tiers.js');
    store.pricingRules.push({
      id: RULE_EVENT_ID,
      scope: 'event',
      kind: 'tier_uplift',
      params: { tierCode: 'commercial', multiplier: 5 },
      priority: 10,
      active: true,
    });
    store.pricingRuleTargets.push({
      ruleId: RULE_EVENT_ID,
      targetType: 'event',
      targetId: EVENT_ID,
    });

    const mult = await resolveTierMultiplier(db as never, {
      eventId: EVENT_ID,
      tierCode: 'personal', // different tier
    });
    // Should use default for personal
    expect(mult).toBe(1);
  });
});

// ---------- assertTierMutable ----------

describe('assertTierMutable', () => {
  it('does not throw when tier codes match', async () => {
    const { assertTierMutable } = await import('../src/services/pricing-tiers.js');
    expect(() => assertTierMutable('commercial', 'commercial')).not.toThrow();
  });

  it('throws PricingTierError with code tier_immutable when codes differ', async () => {
    const { assertTierMutable, PricingTierError } = await import(
      '../src/services/pricing-tiers.js'
    );
    expect(() => assertTierMutable('personal', 'commercial')).toThrow(PricingTierError);
    try {
      assertTierMutable('personal', 'commercial');
    } catch (err) {
      expect(err instanceof PricingTierError).toBe(true);
      expect((err as PricingTierError).code).toBe('tier_immutable');
    }
  });
});

// ---------- listTiers ----------

describe('listTiers', () => {
  it('returns all four tiers with default multipliers when no rules exist', async () => {
    const { listTiers } = await import('../src/services/pricing-tiers.js');
    seedTiers();

    const tiers = await listTiers(db as never);
    expect(tiers).toHaveLength(4);

    const personal = tiers.find((t) => t.code === 'personal');
    const commercial = tiers.find((t) => t.code === 'commercial');
    expect(personal?.multiplier).toBe(1);
    expect(commercial?.multiplier).toBe(3);
  });

  it('applies global rule multiplier when present', async () => {
    const { listTiers } = await import('../src/services/pricing-tiers.js');
    seedTiers();
    store.pricingRules.push({
      id: RULE_GLOBAL_ID,
      scope: 'global',
      kind: 'tier_uplift',
      params: { tierCode: 'commercial', multiplier: 4.5 },
      priority: 0,
      active: true,
    });

    const tiers = await listTiers(db as never);
    const commercial = tiers.find((t) => t.code === 'commercial');
    expect(commercial?.multiplier).toBe(4.5);
  });

  it('includes label and scopeDescription from the DB row', async () => {
    const { listTiers } = await import('../src/services/pricing-tiers.js');
    seedTiers();

    const tiers = await listTiers(db as never);
    const editorial = tiers.find((t) => t.code === 'editorial');
    expect(editorial?.label).toBe('Editorial');
    expect(editorial?.scopeDescription).toBe('News articles');
    expect(editorial?.id).toBe(TIER_EDITORIAL_ID);
  });
});
