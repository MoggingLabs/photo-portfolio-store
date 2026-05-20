// F2.9 — connect.ts service unit tests.
//
// All Stripe calls and DB operations are mocked. Mirrors the refunds.test.ts
// harness: TABLE_KEY store, drizzle shim, @pkg/env z-stub.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- In-memory store ----------

type Row = Record<string, unknown>;

interface Store {
  payoutAccounts: Row[];
  ledgerAccounts: Row[];
  auditLog: Row[];
}

const newStore = (): Store => ({
  payoutAccounts: [],
  ledgerAccounts: [],
  auditLog: [],
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

// ---------- Module mocks ----------

vi.mock('@pkg/db', () => {
  const payoutsTbl = {
    payoutAccounts: tableMarker('payoutAccounts'),
  };
  const complianceTbl = {
    auditLog: tableMarker('auditLog'),
  };
  const payoutsTblFull = {
    ...payoutsTbl,
    ledgerAccounts: tableMarker('ledgerAccounts'),
    tables: {
      ...payoutsTbl,
      ledgerAccounts: tableMarker('ledgerAccounts'),
    },
  };
  return {
    createDbClient: () => ({}),
    schema: {
      payouts: {
        tables: payoutsTblFull,
        ...payoutsTblFull,
      },
      compliance: {
        tables: complianceTbl,
        auditLog: complianceTbl.auditLog,
      },
    },
  };
});

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://stub',
    STRIPE_SECRET_KEY: 'sk_test_stub',
    STRIPE_WEBHOOK_SECRET: 'whsec_stub',
  }),
  z: {
    object: () => ({
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    }),
    string: () => ({
      min: () => ({}),
      optional: () => ({}),
    }),
  },
}));

vi.mock('../src/lib/stripe.js', () => ({
  stripe: {},
  webhookSecret: 'whsec_stub',
}));

// Capture ensurePhotographerAccount calls.
const ensurePhotographerAccountMock = vi.fn().mockResolvedValue('ledger-acct-id');
vi.mock('../src/services/ledger.js', () => ({
  ensurePhotographerAccount: (...args: unknown[]) => ensurePhotographerAccountMock(...args),
}));

// ---------- drizzle-orm shim ----------

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as object);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[v.column] : v);

  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));

  return { eq, and, sql: () => () => true };
});

// ---------- Field shims ----------

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.payouts.tables.payoutAccounts as Record<string, unknown>, [
    'id',
    'photographerId',
    'stripeAccountId',
    'country',
    'currency',
    'chargesEnabled',
    'payoutsEnabled',
    'requirements',
    'status',
    'createdAt',
    'updatedAt',
  ]);
  tag(schema.payouts.tables.ledgerAccounts as Record<string, unknown>, [
    'id',
    'kind',
    'photographerId',
    'createdAt',
  ]);
  tag(schema.compliance.tables.auditLog as Record<string, unknown>, [
    'id',
    'action',
    'actorKind',
    'actorUserId',
    'targetKind',
    'targetId',
    'payloadJsonb',
    'payloadHash',
    'ipHash',
    'userAgent',
    'eventId',
  ]);
};

// ---------- Fake DB ----------

let store: Store;

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, unknown>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | undefined;

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
        if (!bucket) return resolve([]);
        let rows: Row[] = store[bucket].map((r) => ({ ...r }));
        rows = rows.filter((r) => filters.every((f) => f(r)));
        if (limitN !== undefined) rows = rows.slice(0, limitN);
        if (selection) {
          rows = rows.map((row) => {
            const projected: Row = {};
            for (const [alias, ref] of Object.entries(selection)) {
              const fr = ref as { column?: string };
              if (fr.column) projected[alias] = row[fr.column];
              else projected[alias] = row;
            }
            return projected;
          });
        }
        return resolve(rows);
      },
    };
    return api;
  };

  const insertBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let inserted: Row[] = [];
    const api = {
      values(payload: Row | Row[]) {
        const arr = Array.isArray(payload) ? payload : [payload];
        inserted = arr.map((row) => ({
          id: fakeUuid(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...row,
        }));
        store[bucket].push(...inserted.map((r) => ({ ...r })));
        return api;
      },
      returning() {
        return Promise.resolve(inserted.map((r) => ({ ...r })));
      },
      onConflictDoNothing() {
        return api;
      },
      then(resolve: (v: Row[]) => unknown) {
        return resolve(inserted.map((r) => ({ ...r })));
      },
    };
    return api;
  };

  const updateBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let patchData: Row = {};
    const filters: Array<(r: Row) => boolean> = [];

    const api = {
      set(data: Row) {
        patchData = data;
        return api;
      },
      where(pred: (r: Row) => boolean) {
        filters.push(pred);
        return api;
      },
      then(resolve: (v: undefined) => unknown) {
        store[bucket] = store[bucket].map((row) => {
          if (filters.every((f) => f(row))) {
            return { ...row, ...patchData };
          }
          return row;
        });
        return resolve(undefined);
      },
    };
    return api;
  };

  return {
    select: (s?: Record<string, unknown>) => selectBuilder(s),
    insert: (t: Row) => insertBuilder(t),
    update: (t: Row) => updateBuilder(t),
  };
};

// ---------- Fake Stripe ----------

const STRIPE_ACCT_ID = 'acct_test123';
const ONBOARDING_URL = 'https://connect.stripe.com/setup/e/abc123';
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 300;

const makeFakeStripe = (
  overrides: Partial<{
    accountsCreate: ReturnType<typeof vi.fn>;
    accountsRetrieve: ReturnType<typeof vi.fn>;
    accountLinksCreate: ReturnType<typeof vi.fn>;
    accountsCreateLoginLink: ReturnType<typeof vi.fn>;
  }> = {},
) => {
  const accountsCreate =
    overrides.accountsCreate ??
    vi.fn().mockResolvedValue({
      id: STRIPE_ACCT_ID,
      object: 'account',
      charges_enabled: false,
      payouts_enabled: false,
      requirements: { currently_due: ['individual.first_name'] },
    });

  const accountsRetrieve =
    overrides.accountsRetrieve ??
    vi.fn().mockResolvedValue({
      id: STRIPE_ACCT_ID,
      object: 'account',
      charges_enabled: false,
      payouts_enabled: false,
      requirements: { currently_due: ['individual.first_name'], disabled_reason: null },
    });

  const accountLinksCreate =
    overrides.accountLinksCreate ??
    vi.fn().mockResolvedValue({
      object: 'account_link',
      url: ONBOARDING_URL,
      expires_at: EXPIRES_AT,
    });

  const accountsCreateLoginLink =
    overrides.accountsCreateLoginLink ??
    vi.fn().mockResolvedValue({
      object: 'login_link',
      url: 'https://connect.stripe.com/express/dashboard',
    });

  return {
    accounts: {
      create: accountsCreate,
      retrieve: accountsRetrieve,
      createLoginLink: accountsCreateLoginLink,
    },
    accountLinks: {
      create: accountLinksCreate,
    },
    _mocks: { accountsCreate, accountsRetrieve, accountLinksCreate, accountsCreateLoginLink },
  };
};

// ---------- Fixtures ----------

const PHOTOGRAPHER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  vi.clearAllMocks();
  ensurePhotographerAccountMock.mockResolvedValue('ledger-acct-id');
  await installFieldShims();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------- startOnboarding tests ----------

describe('startOnboarding', () => {
  it('creates a Stripe account and persists a payout_accounts row', async () => {
    const db = makeFakeDb();
    const fakeStripe = makeFakeStripe();
    const { startOnboarding } = await import('../src/services/connect.js');

    const result = await startOnboarding(
      db as never,
      PHOTOGRAPHER_ID,
      {
        country: 'US',
        currency: 'usd',
        refreshUrl: 'https://example.com/refresh',
        returnUrl: 'https://example.com/return',
      },
      fakeStripe,
    );

    expect(result.onboardingUrl).toBe(ONBOARDING_URL);
    expect(result.expiresAt).toBeTruthy();

    // Stripe account created exactly once.
    expect(fakeStripe._mocks.accountsCreate).toHaveBeenCalledTimes(1);
    expect(fakeStripe._mocks.accountLinksCreate).toHaveBeenCalledTimes(1);

    // Row persisted in store.
    expect(store.payoutAccounts).toHaveLength(1);
    expect(store.payoutAccounts[0]).toMatchObject({
      photographerId: PHOTOGRAPHER_ID,
      stripeAccountId: STRIPE_ACCT_ID,
      status: 'pending_kyc',
      country: 'US',
      currency: 'usd',
    });
  });

  it('reuses an existing Stripe account on retry (no duplicate accounts.create)', async () => {
    // Pre-seed an existing payout_accounts row with a stripeAccountId.
    store.payoutAccounts.push({
      id: fakeUuid(),
      photographerId: PHOTOGRAPHER_ID,
      stripeAccountId: STRIPE_ACCT_ID,
      country: 'US',
      currency: 'usd',
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: {},
      status: 'pending_kyc',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const db = makeFakeDb();
    const fakeStripe = makeFakeStripe();
    const { startOnboarding } = await import('../src/services/connect.js');

    const result = await startOnboarding(
      db as never,
      PHOTOGRAPHER_ID,
      {
        country: 'US',
        currency: 'usd',
        refreshUrl: 'https://example.com/refresh',
        returnUrl: 'https://example.com/return',
      },
      fakeStripe,
    );

    // No new Stripe account created.
    expect(fakeStripe._mocks.accountsCreate).not.toHaveBeenCalled();
    // A fresh account link is still minted.
    expect(fakeStripe._mocks.accountLinksCreate).toHaveBeenCalledTimes(1);
    expect(result.onboardingUrl).toBe(ONBOARDING_URL);
    // No duplicate payout_accounts row.
    expect(store.payoutAccounts).toHaveLength(1);
  });

  it('calls ensurePhotographerAccount when a new Stripe account is created', async () => {
    const db = makeFakeDb();
    const fakeStripe = makeFakeStripe();
    const { startOnboarding } = await import('../src/services/connect.js');

    await startOnboarding(
      db as never,
      PHOTOGRAPHER_ID,
      {
        country: 'US',
        currency: 'usd',
        refreshUrl: 'https://example.com/refresh',
        returnUrl: 'https://example.com/return',
      },
      fakeStripe,
    );

    expect(ensurePhotographerAccountMock).toHaveBeenCalledWith(expect.anything(), PHOTOGRAPHER_ID);
  });

  it('does NOT call ensurePhotographerAccount when reusing an existing Stripe account', async () => {
    store.payoutAccounts.push({
      id: fakeUuid(),
      photographerId: PHOTOGRAPHER_ID,
      stripeAccountId: STRIPE_ACCT_ID,
      country: 'US',
      currency: 'usd',
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: {},
      status: 'pending_kyc',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const db = makeFakeDb();
    const fakeStripe = makeFakeStripe();
    const { startOnboarding } = await import('../src/services/connect.js');

    await startOnboarding(
      db as never,
      PHOTOGRAPHER_ID,
      {
        country: 'US',
        currency: 'usd',
        refreshUrl: 'https://example.com/refresh',
        returnUrl: 'https://example.com/return',
      },
      fakeStripe,
    );

    expect(ensurePhotographerAccountMock).not.toHaveBeenCalled();
  });

  it('throws stripe_error when Stripe account creation fails', async () => {
    const db = makeFakeDb();
    const fakeStripe = makeFakeStripe({
      accountsCreate: vi.fn().mockRejectedValue(new Error('Stripe down')),
    });
    const { startOnboarding, ConnectServiceError } = await import('../src/services/connect.js');

    await expect(
      startOnboarding(
        db as never,
        PHOTOGRAPHER_ID,
        {
          country: 'US',
          currency: 'usd',
          refreshUrl: 'https://example.com/refresh',
          returnUrl: 'https://example.com/return',
        },
        fakeStripe,
      ),
    ).rejects.toMatchObject({ code: 'stripe_error' } as Partial<
      InstanceType<typeof ConnectServiceError>
    >);
  });
});

// ---------- getKycStatus tests ----------

describe('getKycStatus', () => {
  it('returns incomplete status with continueUrl when KYC is pending', async () => {
    store.payoutAccounts.push({
      id: fakeUuid(),
      photographerId: PHOTOGRAPHER_ID,
      stripeAccountId: STRIPE_ACCT_ID,
      country: 'US',
      currency: 'usd',
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: {},
      status: 'pending_kyc',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const db = makeFakeDb();
    const fakeStripe = makeFakeStripe();
    const { getKycStatus } = await import('../src/services/connect.js');

    const result = await getKycStatus(
      db as never,
      PHOTOGRAPHER_ID,
      { refreshUrl: 'https://example.com/refresh', returnUrl: 'https://example.com/return' },
      fakeStripe,
    );

    expect(result.chargesEnabled).toBe(false);
    expect(result.payoutsEnabled).toBe(false);
    expect(result.currentlyDue).toContain('individual.first_name');
    expect(result.continueUrl).toBe(ONBOARDING_URL);
    expect(result.dashboardUrl).toBeUndefined();
  });

  it('returns active status with dashboardUrl when KYC is complete', async () => {
    store.payoutAccounts.push({
      id: fakeUuid(),
      photographerId: PHOTOGRAPHER_ID,
      stripeAccountId: STRIPE_ACCT_ID,
      country: 'US',
      currency: 'usd',
      chargesEnabled: true,
      payoutsEnabled: true,
      requirements: {},
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const db = makeFakeDb();
    const fakeStripe = makeFakeStripe({
      accountsRetrieve: vi.fn().mockResolvedValue({
        id: STRIPE_ACCT_ID,
        charges_enabled: true,
        payouts_enabled: true,
        requirements: { currently_due: [], disabled_reason: null },
      }),
    });
    const { getKycStatus } = await import('../src/services/connect.js');

    const result = await getKycStatus(
      db as never,
      PHOTOGRAPHER_ID,
      { refreshUrl: 'https://example.com/refresh', returnUrl: 'https://example.com/return' },
      fakeStripe,
    );

    expect(result.status).toBe('active');
    expect(result.chargesEnabled).toBe(true);
    expect(result.payoutsEnabled).toBe(true);
    expect(result.currentlyDue).toHaveLength(0);
    expect(result.dashboardUrl).toBe('https://connect.stripe.com/express/dashboard');
    expect(result.continueUrl).toBeUndefined();
  });

  it('throws account_not_found when no payout_accounts row exists', async () => {
    const db = makeFakeDb();
    const fakeStripe = makeFakeStripe();
    const { getKycStatus, ConnectServiceError } = await import('../src/services/connect.js');

    await expect(
      getKycStatus(
        db as never,
        PHOTOGRAPHER_ID,
        { refreshUrl: 'https://example.com/refresh', returnUrl: 'https://example.com/return' },
        fakeStripe,
      ),
    ).rejects.toMatchObject({ code: 'account_not_found' } as Partial<
      InstanceType<typeof ConnectServiceError>
    >);
  });
});

// ---------- handleAccountUpdated tests ----------

describe('handleAccountUpdated', () => {
  it('sets status active when both charges and payouts are enabled', async () => {
    store.payoutAccounts.push({
      id: fakeUuid(),
      photographerId: PHOTOGRAPHER_ID,
      stripeAccountId: STRIPE_ACCT_ID,
      country: 'US',
      currency: 'usd',
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: {},
      status: 'pending_kyc',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const db = makeFakeDb();
    const { handleAccountUpdated } = await import('../src/services/connect.js');

    await handleAccountUpdated(
      db as never,
      {
        id: STRIPE_ACCT_ID,
        charges_enabled: true,
        payouts_enabled: true,
        requirements: { currently_due: [], disabled_reason: null },
      } as never,
    );

    const [row] = store.payoutAccounts;
    expect(row?.status).toBe('active');
    expect(row?.chargesEnabled).toBe(true);
    expect(row?.payoutsEnabled).toBe(true);
  });

  it('sets status restricted when Stripe sets a disabled_reason', async () => {
    store.payoutAccounts.push({
      id: fakeUuid(),
      photographerId: PHOTOGRAPHER_ID,
      stripeAccountId: STRIPE_ACCT_ID,
      country: 'US',
      currency: 'usd',
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: {},
      status: 'pending_kyc',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const db = makeFakeDb();
    const { handleAccountUpdated } = await import('../src/services/connect.js');

    await handleAccountUpdated(
      db as never,
      {
        id: STRIPE_ACCT_ID,
        charges_enabled: false,
        payouts_enabled: false,
        requirements: {
          currently_due: ['individual.id_number'],
          disabled_reason: 'requirements.past_due',
        },
      } as never,
    );

    const [row] = store.payoutAccounts;
    expect(row?.status).toBe('restricted');
  });

  it('sets status pending_kyc when requirements are outstanding but no disabled_reason', async () => {
    store.payoutAccounts.push({
      id: fakeUuid(),
      photographerId: PHOTOGRAPHER_ID,
      stripeAccountId: STRIPE_ACCT_ID,
      country: 'US',
      currency: 'usd',
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: {},
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const db = makeFakeDb();
    const { handleAccountUpdated } = await import('../src/services/connect.js');

    await handleAccountUpdated(
      db as never,
      {
        id: STRIPE_ACCT_ID,
        charges_enabled: false,
        payouts_enabled: false,
        requirements: { currently_due: ['individual.first_name'], disabled_reason: null },
      } as never,
    );

    const [row] = store.payoutAccounts;
    expect(row?.status).toBe('pending_kyc');
  });

  it('is idempotent when called twice with the same account state', async () => {
    store.payoutAccounts.push({
      id: fakeUuid(),
      photographerId: PHOTOGRAPHER_ID,
      stripeAccountId: STRIPE_ACCT_ID,
      country: 'US',
      currency: 'usd',
      chargesEnabled: true,
      payoutsEnabled: true,
      requirements: {},
      status: 'pending_kyc',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const db = makeFakeDb();
    const { handleAccountUpdated } = await import('../src/services/connect.js');

    const payload = {
      id: STRIPE_ACCT_ID,
      charges_enabled: true,
      payouts_enabled: true,
      requirements: { currently_due: [], disabled_reason: null },
    } as never;

    await handleAccountUpdated(db as never, payload);
    await handleAccountUpdated(db as never, payload);

    expect(store.payoutAccounts).toHaveLength(1);
    expect(store.payoutAccounts[0]?.status).toBe('active');
  });
});
