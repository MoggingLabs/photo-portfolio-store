// F2.9 — Stripe Connect Express onboarding service.
//
// Hosted onboarding: we never collect KYC ourselves. Buyers already pay the
// platform; transfers to photographers happen in F2.12. This module owns:
//   - Stripe account creation (idempotent via idempotencyKey).
//   - Account-link generation for the onboarding flow.
//   - KYC status reads + continuation links.
//   - Reconciling payout_accounts when `account.updated` webhooks arrive.
//
// The StripeConnectClient seam lets tests inject a fake without widening the
// shared singleton.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';

import { writeAudit } from '../lib/audit.js';
import { stripe as defaultStripe } from '../lib/stripe.js';
import { ensurePhotographerAccount } from './ledger.js';

const { payoutAccounts } = schema.payouts.tables;

// ---------- Narrow Stripe seam ----------

// Only the sub-objects we actually use. Tests inject a partial fake.
export type StripeConnectClient = Pick<Stripe, 'accounts' | 'accountLinks'>;

// ---------- Error ----------

export type ConnectErrorCode =
  | 'already_onboarded'
  | 'account_not_found'
  | 'stripe_error'
  | 'invalid_request';

export class ConnectServiceError extends Error {
  constructor(
    public readonly code: ConnectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectServiceError';
  }
}

// ---------- Public result types ----------

export interface OnboardingStart {
  onboardingUrl: string;
  expiresAt: string; // ISO 8601
}

export interface KycStatus {
  status: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  currentlyDue: string[];
  /** Present when onboarding is incomplete — a fresh account link URL. */
  continueUrl?: string;
  /** Present when onboarding is complete — a Stripe Express dashboard login link. */
  dashboardUrl?: string;
}

// ---------- Helpers ----------

// Narrow shape returned by drizzle when we select a payout_accounts row.
interface PayoutAccountRow {
  id: string;
  photographerId: string;
  stripeAccountId: string | null;
  country: string;
  currency: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirements: unknown;
  status: string;
}

const resolvePayoutAccount = async (
  db: DbClient,
  photographerId: string,
): Promise<PayoutAccountRow | null> => {
  const rows = await db
    .select()
    .from(payoutAccounts)
    .where(eq(payoutAccounts.photographerId, photographerId))
    .limit(1);
  const [row] = rows;
  return (row as PayoutAccountRow | undefined) ?? null;
};

const deriveStatus = (acct: Stripe.Account): string => {
  if (acct.payouts_enabled && acct.charges_enabled) return 'active';
  const reason =
    acct.requirements?.disabled_reason ?? acct.requirements?.pending_verification?.[0] ?? null;
  if (reason) return 'restricted';
  return 'pending_kyc';
};

// ---------- startOnboarding ----------

export interface StartOnboardingOpts {
  country: string;
  currency: string;
  refreshUrl: string;
  returnUrl: string;
}

export const startOnboarding = async (
  db: DbClient,
  photographerId: string,
  opts: StartOnboardingOpts,
  stripeClient: StripeConnectClient = defaultStripe,
): Promise<OnboardingStart> => {
  const { country, currency, refreshUrl, returnUrl } = opts;

  const existing = await resolvePayoutAccount(db, photographerId);

  let stripeAccountId: string;

  if (existing?.stripeAccountId) {
    // Reuse existing Stripe account — never create duplicates.
    stripeAccountId = existing.stripeAccountId;
  } else {
    // Create a new Express account. The idempotency key prevents a duplicate
    // Stripe account if the caller retries before we persist the row.
    let created: Stripe.Account;
    try {
      created = await stripeClient.accounts.create(
        {
          type: 'express',
          country,
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          metadata: { photographerId },
        },
        { idempotencyKey: `connect-acct:${photographerId}` },
      );
    } catch (err) {
      throw new ConnectServiceError(
        'stripe_error',
        err instanceof Error ? err.message : 'Stripe account creation failed',
      );
    }

    stripeAccountId = created.id;

    if (existing) {
      // Row exists but stripeAccountId was null — update in-place.
      await db
        .update(payoutAccounts)
        .set({
          stripeAccountId,
          status: 'pending_kyc',
          updatedAt: new Date(),
        })
        .where(eq(payoutAccounts.photographerId, photographerId));
    } else {
      // First time — insert a new row.
      await db.insert(payoutAccounts).values({
        photographerId,
        stripeAccountId,
        country,
        currency,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirements: {},
        status: 'pending_kyc',
      });
    }

    // Ensure the internal ledger account exists so earnings can accrue
    // before KYC completes (independent of Stripe).
    await ensurePhotographerAccount(db, photographerId);

    await writeAudit(db, {
      action: 'connect.account.created',
      actorKind: 'user',
      actorUserId: photographerId,
      targetKind: 'payout_account',
      targetId: stripeAccountId,
      payload: { photographerId, country, currency },
    });
  }

  // Generate a hosted onboarding link. Always fresh — links expire quickly.
  let link: Stripe.AccountLink;
  try {
    link = await stripeClient.accountLinks.create({
      account: stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
  } catch (err) {
    throw new ConnectServiceError(
      'stripe_error',
      err instanceof Error ? err.message : 'Stripe account link creation failed',
    );
  }

  return {
    onboardingUrl: link.url,
    expiresAt: new Date(link.expires_at * 1000).toISOString(),
  };
};

// ---------- getKycStatus ----------

export interface GetKycStatusOpts {
  refreshUrl: string;
  returnUrl: string;
}

export const getKycStatus = async (
  db: DbClient,
  photographerId: string,
  opts: GetKycStatusOpts,
  stripeClient: StripeConnectClient = defaultStripe,
): Promise<KycStatus> => {
  const account = await resolvePayoutAccount(db, photographerId);
  if (!account?.stripeAccountId) {
    throw new ConnectServiceError(
      'account_not_found',
      'No Stripe Connect account found for this photographer',
    );
  }

  let stripeAccount: Stripe.Account;
  try {
    stripeAccount = await stripeClient.accounts.retrieve(account.stripeAccountId);
  } catch (err) {
    throw new ConnectServiceError(
      'stripe_error',
      err instanceof Error ? err.message : 'Failed to retrieve Stripe account',
    );
  }

  const currentlyDue: string[] = stripeAccount.requirements?.currently_due ?? [];
  const chargesEnabled = stripeAccount.charges_enabled ?? false;
  const payoutsEnabled = stripeAccount.payouts_enabled ?? false;
  const status = deriveStatus(stripeAccount);

  const isComplete = chargesEnabled && payoutsEnabled && currentlyDue.length === 0;

  if (isComplete) {
    // Provide a dashboard login link so the photographer can view payouts.
    let dashboardUrl: string | undefined;
    try {
      // stripe.accounts does not expose createLoginLink in the Pick type we
      // defined — cast narrowly to access it.
      const loginLink = await (stripeClient.accounts as Stripe['accounts']).createLoginLink(
        account.stripeAccountId,
      );
      dashboardUrl = loginLink.url;
    } catch {
      // Non-fatal: dashboard link is informational.
    }

    return {
      status,
      chargesEnabled,
      payoutsEnabled,
      currentlyDue,
      dashboardUrl,
    };
  }

  // Incomplete — generate a fresh continuation link.
  let continueUrl: string | undefined;
  try {
    const link = await stripeClient.accountLinks.create({
      account: account.stripeAccountId,
      refresh_url: opts.refreshUrl,
      return_url: opts.returnUrl,
      type: 'account_onboarding',
    });
    continueUrl = link.url;
  } catch {
    // Non-fatal: best-effort continuation link.
  }

  return {
    status,
    chargesEnabled,
    payoutsEnabled,
    currentlyDue,
    continueUrl,
  };
};

// ---------- handleAccountUpdated ----------

// Called by the webhook dispatch when an `account.updated` event arrives.
// Idempotent: UPDATE by stripe_account_id; no-op if the row is already
// in the correct state.
export const handleAccountUpdated = async (
  db: DbClient,
  account: Stripe.Account,
): Promise<void> => {
  const chargesEnabled = account.charges_enabled ?? false;
  const payoutsEnabled = account.payouts_enabled ?? false;
  const requirements = (account.requirements as unknown as Record<string, unknown>) ?? {};
  const status = deriveStatus(account);

  await db
    .update(payoutAccounts)
    .set({
      chargesEnabled,
      payoutsEnabled,
      requirements,
      status,
      updatedAt: new Date(),
    })
    .where(eq(payoutAccounts.stripeAccountId, account.id));

  await writeAudit(db, {
    action: 'connect.account.updated',
    actorKind: 'webhook',
    targetKind: 'payout_account',
    targetId: account.id,
    payload: { chargesEnabled, payoutsEnabled, status },
  });
};
