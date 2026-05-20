// F2.11 — ledger writer unit tests. In-memory fake DB; no real Postgres.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  ledgerAccounts: Row[];
  ledgerEntries: Row[];
}

const TABLE_KEY = Symbol('table-key');
const tableMarker = (key: keyof Store): Row => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

let uuidCounter = 0;
const fakeUuid = (): string => {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
};

vi.mock('@pkg/db', () => {
  const payoutsTables = {
    ledgerAccounts: tableMarker('ledgerAccounts'),
    ledgerEntries: tableMarker('ledgerEntries'),
  };
  return {
    createDbClient: () => ({}),
    schema: { payouts: { tables: payoutsTables } },
  };
});

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: { object: () => ({ parse: (v: unknown) => v }), string: () => ({ min: () => ({}) }) },
}));

// drizzle-orm shim: eq/and produce row predicates; fields carry { column }.
vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[v.column] : v);
  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  return { eq, and };
});

let store: Store;

// Unique keys mirroring the partial indexes the real DB enforces.
const accountConflictKey = (row: Row): string =>
  row.kind === 'photographer' ? `photographer:${row.photographerId}` : `kind:${row.kind}`;
const entryDedupeKey = (row: Row): string | null =>
  row.orderId == null ? null : `${row.orderId}:${row.kind}:${row.accountId}:${row.direction}`;

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, { column: string }>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | undefined;
    const exec = (): Row[] => {
      if (!bucket) return [];
      let rows = store[bucket].filter((r) => filters.every((f) => f(r)));
      if (limitN !== undefined) rows = rows.slice(0, limitN);
      if (selection) {
        rows = rows.map((r) => {
          const projected: Row = {};
          for (const [alias, ref] of Object.entries(selection)) projected[alias] = r[ref.column];
          return projected;
        });
      }
      return rows.map((r) => ({ ...r }));
    };
    const api = {
      from(table: Row) {
        bucket = table[TABLE_KEY] as keyof Store;
        return api;
      },
      where(pred: (r: Row) => boolean) {
        filters.push(pred);
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown) {
        return resolve(exec());
      },
    };
    return api;
  };

  const insertBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let pending: Row[] = [];
    let conflictGuard = false;
    const commit = (): Row[] => {
      const written: Row[] = [];
      for (const row of pending) {
        if (conflictGuard) {
          if (bucket === 'ledgerAccounts') {
            const key = accountConflictKey(row);
            if (store.ledgerAccounts.some((r) => accountConflictKey(r) === key)) continue;
          } else if (bucket === 'ledgerEntries') {
            const key = entryDedupeKey(row);
            if (key !== null && store.ledgerEntries.some((r) => entryDedupeKey(r) === key))
              continue;
          }
        }
        const full = { id: fakeUuid(), createdAt: new Date(), ...row };
        store[bucket].push(full);
        written.push(full);
      }
      return written;
    };
    const api = {
      values(payload: Row | Row[]) {
        pending = Array.isArray(payload) ? payload : [payload];
        return api;
      },
      onConflictDoNothing() {
        conflictGuard = true;
        return api;
      },
      returning(selection?: Record<string, { column: string }>) {
        const written = commit();
        const rows = selection
          ? written.map((w) => {
              const p: Row = {};
              for (const [alias, ref] of Object.entries(selection)) p[alias] = w[ref.column];
              return p;
            })
          : written;
        return Promise.resolve(rows);
      },
      then(resolve: (v: unknown) => unknown) {
        commit();
        return resolve(undefined);
      },
    };
    return api;
  };

  const db = {
    select: (s?: Record<string, { column: string }>) => selectBuilder(s),
    insert: (t: Row) => insertBuilder(t),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };
  return db;
};

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const acct = schema.payouts.tables.ledgerAccounts as Record<string, unknown>;
  for (const c of ['id', 'kind', 'photographerId', 'createdAt']) acct[c] = { column: c };
  const entry = schema.payouts.tables.ledgerEntries as Record<string, unknown>;
  for (const c of [
    'id',
    'accountId',
    'orderId',
    'refundId',
    'payoutId',
    'direction',
    'amountCents',
    'currency',
    'kind',
    'memo',
    'createdAt',
  ])
    entry[c] = { column: c };
};

let db: ReturnType<typeof makeFakeDb>;

beforeEach(async () => {
  store = { ledgerAccounts: [], ledgerEntries: [] };
  uuidCounter = 0;
  await installFieldShims();
  db = makeFakeDb();
});

describe('assertBalanced', () => {
  it('accepts a balanced batch', async () => {
    const { assertBalanced } = await import('../src/services/ledger.js');
    expect(() =>
      assertBalanced([
        {
          accountId: 'a',
          direction: 'debit',
          amountCents: 100,
          currency: 'usd',
          kind: 'sale',
          memo: 'm',
        },
        {
          accountId: 'b',
          direction: 'credit',
          amountCents: 100,
          currency: 'usd',
          kind: 'sale',
          memo: 'm',
        },
      ]),
    ).not.toThrow();
  });

  it('rejects an unbalanced batch', async () => {
    const { assertBalanced, LedgerError } = await import('../src/services/ledger.js');
    expect(() =>
      assertBalanced([
        {
          accountId: 'a',
          direction: 'debit',
          amountCents: 100,
          currency: 'usd',
          kind: 'sale',
          memo: 'm',
        },
        {
          accountId: 'b',
          direction: 'credit',
          amountCents: 90,
          currency: 'usd',
          kind: 'sale',
          memo: 'm',
        },
      ]),
    ).toThrowError(LedgerError);
  });

  it('balances per-currency independently', async () => {
    const { assertBalanced } = await import('../src/services/ledger.js');
    expect(() =>
      assertBalanced([
        {
          accountId: 'a',
          direction: 'debit',
          amountCents: 100,
          currency: 'usd',
          kind: 'sale',
          memo: 'm',
        },
        {
          accountId: 'b',
          direction: 'credit',
          amountCents: 100,
          currency: 'usd',
          kind: 'sale',
          memo: 'm',
        },
        {
          accountId: 'c',
          direction: 'debit',
          amountCents: 50,
          currency: 'eur',
          kind: 'sale',
          memo: 'm',
        },
        {
          accountId: 'd',
          direction: 'credit',
          amountCents: 50,
          currency: 'eur',
          kind: 'sale',
          memo: 'm',
        },
      ]),
    ).not.toThrow();
  });

  it('rejects non-positive or non-integer amounts', async () => {
    const { assertBalanced } = await import('../src/services/ledger.js');
    expect(() =>
      assertBalanced([
        {
          accountId: 'a',
          direction: 'debit',
          amountCents: 0,
          currency: 'usd',
          kind: 'sale',
          memo: 'm',
        },
        {
          accountId: 'b',
          direction: 'credit',
          amountCents: 0,
          currency: 'usd',
          kind: 'sale',
          memo: 'm',
        },
      ]),
    ).toThrow();
  });
});

describe('allocateProportional', () => {
  it('sums exactly to the total (no rounding leak)', async () => {
    const { allocateProportional } = await import('../src/services/ledger.js');
    const parts = allocateProportional(100, [1, 1, 1]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]); // leftover cent to the first by tie-break
  });

  it('weights proportionally and stays cents-exact', async () => {
    const { allocateProportional } = await import('../src/services/ledger.js');
    const parts = allocateProportional(10_000, [8, 2]); // 80/20 of 100.00
    expect(parts).toEqual([8000, 2000]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(10_000);
  });

  it('property: random splits always conserve the total', async () => {
    const { allocateProportional } = await import('../src/services/ledger.js');
    for (let t = 0; t < 200; t += 1) {
      const total = Math.floor(Math.random() * 100_000);
      const k = 1 + Math.floor(Math.random() * 7);
      const weights = Array.from({ length: k }, () => Math.floor(Math.random() * 50));
      const parts = allocateProportional(total, weights);
      expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
      expect(parts.every((p) => p >= 0)).toBe(true);
    }
  });

  it('even-splits when all weights are zero', async () => {
    const { allocateProportional } = await import('../src/services/ledger.js');
    const parts = allocateProportional(10, [0, 0, 0, 0]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(10);
  });

  it('handles negative totals (reversals)', async () => {
    const { allocateProportional } = await import('../src/services/ledger.js');
    const parts = allocateProportional(-100, [1, 1, 1]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(-100);
  });
});

describe('fee estimators', () => {
  it('computes platform fee at default 10%', async () => {
    const { estimatePlatformFeeCents } = await import('../src/services/ledger.js');
    expect(estimatePlatformFeeCents(10_000)).toBe(1000);
    expect(estimatePlatformFeeCents(999)).toBe(100); // round(99.9)
  });

  it('computes stripe fee at 2.9% + 30c', async () => {
    const { estimateStripeFeeCents } = await import('../src/services/ledger.js');
    expect(estimateStripeFeeCents(10_000)).toBe(290 + 30);
  });
});

describe('postLedgerBatch', () => {
  it('writes a balanced batch', async () => {
    const { postLedgerBatch } = await import('../src/services/ledger.js');
    await postLedgerBatch(db as never, [
      {
        accountId: 'cash',
        direction: 'debit',
        amountCents: 100,
        currency: 'usd',
        kind: 'sale',
        memo: 'm',
        orderId: 'o1',
      },
      {
        accountId: 'photog',
        direction: 'credit',
        amountCents: 100,
        currency: 'usd',
        kind: 'sale',
        memo: 'm',
        orderId: 'o1',
      },
    ]);
    expect(store.ledgerEntries).toHaveLength(2);
  });

  it('refuses to write an unbalanced batch', async () => {
    const { postLedgerBatch, LedgerError } = await import('../src/services/ledger.js');
    await expect(
      postLedgerBatch(db as never, [
        {
          accountId: 'cash',
          direction: 'debit',
          amountCents: 100,
          currency: 'usd',
          kind: 'sale',
          memo: 'm',
          orderId: 'o1',
        },
        {
          accountId: 'photog',
          direction: 'credit',
          amountCents: 90,
          currency: 'usd',
          kind: 'sale',
          memo: 'm',
          orderId: 'o1',
        },
      ]),
    ).rejects.toBeInstanceOf(LedgerError);
    expect(store.ledgerEntries).toHaveLength(0);
  });

  it('is idempotent for order-scoped entries (replay is a no-op)', async () => {
    const { postLedgerBatch } = await import('../src/services/ledger.js');
    const batch = [
      {
        accountId: 'cash',
        direction: 'debit' as const,
        amountCents: 100,
        currency: 'usd',
        kind: 'sale' as const,
        memo: 'm',
        orderId: 'o1',
      },
      {
        accountId: 'photog',
        direction: 'credit' as const,
        amountCents: 100,
        currency: 'usd',
        kind: 'sale' as const,
        memo: 'm',
        orderId: 'o1',
      },
    ];
    await postLedgerBatch(db as never, batch);
    await postLedgerBatch(db as never, batch);
    expect(store.ledgerEntries).toHaveLength(2);
  });
});

describe('account resolution', () => {
  it('getPlatformAccountId creates then reuses the singleton', async () => {
    const { getPlatformAccountId } = await import('../src/services/ledger.js');
    const a = await getPlatformAccountId(db as never, 'platform_cash');
    const b = await getPlatformAccountId(db as never, 'platform_cash');
    expect(a).toBe(b);
    expect(store.ledgerAccounts.filter((r) => r.kind === 'platform_cash')).toHaveLength(1);
  });

  it('ensurePhotographerAccount is one-per-user', async () => {
    const { ensurePhotographerAccount } = await import('../src/services/ledger.js');
    const a = await ensurePhotographerAccount(db as never, 'user-1');
    const b = await ensurePhotographerAccount(db as never, 'user-1');
    const c = await ensurePhotographerAccount(db as never, 'user-2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(store.ledgerAccounts.filter((r) => r.kind === 'photographer')).toHaveLength(2);
  });

  it('seedPlatformLedgerAccounts creates the three singletons idempotently', async () => {
    const { seedPlatformLedgerAccounts } = await import('../src/services/ledger.js');
    await seedPlatformLedgerAccounts(db as never);
    await seedPlatformLedgerAccounts(db as never);
    expect(store.ledgerAccounts).toHaveLength(3);
  });
});

describe('accountBalanceCents', () => {
  it('computes credits minus debits', async () => {
    const { postLedgerBatch, accountBalanceCents } = await import('../src/services/ledger.js');
    await postLedgerBatch(db as never, [
      {
        accountId: 'photog',
        direction: 'credit',
        amountCents: 600,
        currency: 'usd',
        kind: 'sale',
        memo: 'm',
        orderId: 'o1',
      },
      {
        accountId: 'cash',
        direction: 'debit',
        amountCents: 600,
        currency: 'usd',
        kind: 'sale',
        memo: 'm',
        orderId: 'o1',
      },
    ]);
    expect(await accountBalanceCents(db as never, 'photog')).toBe(600);
    expect(await accountBalanceCents(db as never, 'cash')).toBe(-600);
  });
});
