// Route test for GET /v1/pricing/tiers. Uses the same in-memory fake DB
// pattern as products.test.ts and cart.test.ts.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    const av = a[field.column] as number;
    const bv = b[field.column] as number;
    return av > bv ? -1 : av < bv ? 1 : 0;
  };
  const sqlTag = ((_strings: TemplateStringsArray) => ({ __sql: '' })) as unknown as Record<
    string,
    unknown
  >;
  return { eq, and, desc, sql: sqlTag };
});

// ---------- Fake DB ----------

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
    let joinBucket: keyof Store | null = null;
    let joinOnFn: ((mergedRow: Row) => boolean) | null = null;

    const api = {
      from(table: Row) {
        bucket = table[TABLE_KEY] as keyof Store;
        return api;
      },
      innerJoin(table: Row, on: (mergedRow: Row) => boolean) {
        joinBucket = table[TABLE_KEY] as keyof Store;
        joinOnFn = on;
        return api;
      },
      where(predicate: (r: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      // drizzle .orderBy accepts comparator functions (e.g. desc(col)) or a
      // raw column Field for ascending order (e.g. orderBy(table.col)).
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
            const primary = store[bucket];
            const secondary = store[joinBucket];
            rows = primary
              .flatMap((p) =>
                secondary.map((s) => ({ ...s, ...p })).filter((merged) => joinOnFn!(merged)),
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

  return {
    select: (selection?: Record<string, unknown>) => selectBuilder(selection),
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

// ---------- Seed data ----------

const TIER_PERSONAL_ID = '00000000-0000-4000-8000-000000000001';
const TIER_SOCIAL_ID = '00000000-0000-4000-8000-000000000002';
const TIER_EDITORIAL_ID = '00000000-0000-4000-8000-000000000003';
const TIER_COMMERCIAL_ID = '00000000-0000-4000-8000-000000000004';
const EVENT_ID = '00000000-0000-4000-8000-0000000000aa';

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

// ---------- Lifecycle ----------

let app: FastifyInstance;
let db: ReturnType<typeof makeFakeDb>;

beforeEach(async () => {
  store = newStore();
  await installFieldShims();
  db = makeFakeDb();

  const { default: pricingRoutes } = await import('../src/routes/pricing.js');
  app = Fastify({ logger: false });
  await app.register(async (instance) => {
    await pricingRoutes(instance, { db: db as never });
  });
  await app.ready();
  seedTiers();
});

afterEach(async () => {
  await app.close();
  vi.clearAllMocks();
});

// ---------- Tests ----------

describe('GET /v1/pricing/tiers', () => {
  it('returns 200 with all four tiers', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/pricing/tiers' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tiers: Array<{ code: string; multiplier: number }> };
    expect(body.tiers).toHaveLength(4);
    const codes = body.tiers.map((t) => t.code).sort();
    expect(codes).toEqual(['commercial', 'editorial', 'personal', 'social']);
  });

  it('returns default multipliers when no pricing rules exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/pricing/tiers' });
    const body = res.json() as { tiers: Array<{ code: string; multiplier: number }> };
    const personal = body.tiers.find((t) => t.code === 'personal');
    const social = body.tiers.find((t) => t.code === 'social');
    const editorial = body.tiers.find((t) => t.code === 'editorial');
    const commercial = body.tiers.find((t) => t.code === 'commercial');
    expect(personal?.multiplier).toBe(1);
    expect(social?.multiplier).toBe(1.5);
    expect(editorial?.multiplier).toBe(2);
    expect(commercial?.multiplier).toBe(3);
  });

  it('each tier has id, code, label, multiplier, scopeDescription', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/pricing/tiers' });
    const body = res.json() as {
      tiers: Array<{
        id: string;
        code: string;
        label: string;
        multiplier: number;
        scopeDescription: string;
      }>;
    };
    for (const tier of body.tiers) {
      expect(typeof tier.id).toBe('string');
      expect(typeof tier.code).toBe('string');
      expect(typeof tier.label).toBe('string');
      expect(typeof tier.multiplier).toBe('number');
      expect(typeof tier.scopeDescription).toBe('string');
    }
  });

  it('accepts optional ?eventId query param (valid UUID)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/pricing/tiers?eventId=${EVENT_ID}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tiers: unknown[] };
    expect(body.tiers).toHaveLength(4);
  });

  it('returns 400 for invalid eventId (not a UUID)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/pricing/tiers?eventId=not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe('invalid_query');
  });

  it('applies global pricing rule multiplier', async () => {
    store.pricingRules.push({
      id: '00000000-0000-4000-8000-000000000010',
      scope: 'global',
      kind: 'tier_uplift',
      params: { tierCode: 'commercial', multiplier: 4 },
      priority: 0,
      active: true,
    });

    const res = await app.inject({ method: 'GET', url: '/v1/pricing/tiers' });
    const body = res.json() as { tiers: Array<{ code: string; multiplier: number }> };
    const commercial = body.tiers.find((t) => t.code === 'commercial');
    expect(commercial?.multiplier).toBe(4);
  });
});
