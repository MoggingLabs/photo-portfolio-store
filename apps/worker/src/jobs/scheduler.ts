// Cron scheduler bootstrap. Owns the croner instances; the worker entrypoint
// calls startSchedulers() once at boot and keeps the returned handles so they
// can be stopped on shutdown.

import type { Readable } from 'node:stream';
import {
  BayPhotoAdapter,
  ChronoTrackAdapter,
  type CloudDownloader,
  type CloudHttpClient,
  type CloudProvider,
  type CloudStorageAdapter,
  type CloudTokenSet,
  type LabHttpClient,
  MyLapsAdapter,
  type OAuthClientCredentials,
  type PrintLabAdapter,
  RunSignupAdapter,
  type TimingHttpClient,
  type TimingProvider,
  type TimingProviderAdapter,
  createCloudStorageAdapter,
  refreshAccessToken,
} from '@pkg/integrations';
import { Cron } from 'croner';
import pino from 'pino';
import { request } from 'undici';

import { db } from '../lib/db.js';
import { workerEnv } from '../lib/env.js';
import { qdrant } from '../lib/qdrant.js';
import { buckets, getS3 } from '../lib/storage.js';
import { getIngestQueue } from '../queues/index.js';
import { runBipaRetentionDestruction } from './bipa-retention.js';
import { runCloudImport } from './cloud-import.js';
import { type EmailSender, runNotificationSend } from './notifications-send.js';
import { triggerNotificationEnqueue, triggerPayoutRun } from './payouts.js';
import {
  type AdapterResolver,
  runPrintStatusPolls,
  runPrintSubmissions,
} from './print-fulfillment.js';
import { runRetentionPass } from './retention.js';
import { runTakedownSlaCheck } from './takedown-sla.js';
import { type TimingAdapterFactory, runTimingSync } from './timing-sync.js';
import { type WebhookHttpClient, runWebhookDeliveries } from './webhook-delivery.js';

const log = pino({ name: 'retention-scheduler' });
const payoutLog = pino({ name: 'payout-scheduler' });
const slaLog = pino({ name: 'takedown-sla' });
const bipaLog = pino({ name: 'bipa-retention' });
const webhookLog = pino({ name: 'webhook-delivery' });
const notifyLog = pino({ name: 'notifications-send' });

// F4.12 — email sender for notifications. SMTP via SMTP_URL (Mailhog locally);
// Resend via RESEND_API_KEY in production. Mirrors the fulfillment emailer.
const notificationEmailSender: EmailSender = async (msg) => {
  const from = process.env.EMAIL_FROM ?? 'Photos <no-reply@example.com>';
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const res = await request('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });
    const body = (await res.body.json().catch(() => ({}))) as { id?: string };
    if (res.statusCode >= 300) throw new Error(`resend ${res.statusCode}`);
    return { messageId: body.id };
  }
  const smtpUrl = process.env.SMTP_URL;
  if (!smtpUrl) throw new Error('no email transport configured (SMTP_URL / RESEND_API_KEY)');
  const nm = (await import('nodemailer')) as {
    default?: typeof import('nodemailer');
  } & typeof import('nodemailer');
  const nodemailer = nm.default ?? nm;
  const transport = nodemailer.createTransport(smtpUrl);
  const info = await transport.sendMail({
    from,
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  });
  return { messageId: (info as { messageId?: string }).messageId };
};
const printLog = pino({ name: 'print-fulfillment' });
const timingLog = pino({ name: 'timing-sync' });

const WEBHOOK_TIMEOUT_MS = 10_000;

const webhookHttpClient: WebhookHttpClient = async (url, body, headers) => {
  const res = await request(url, {
    method: 'POST',
    body,
    headers,
    headersTimeout: WEBHOOK_TIMEOUT_MS,
    bodyTimeout: WEBHOOK_TIMEOUT_MS,
  });
  const text = await res.body.text();
  return { status: res.statusCode, body: text };
};

const labHttpClient: LabHttpClient = async (method, url, headers, body) => {
  const res = await request(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headersTimeout: WEBHOOK_TIMEOUT_MS,
    bodyTimeout: WEBHOOK_TIMEOUT_MS,
  });
  const text = await res.body.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body; keep raw text */
  }
  return { status: res.statusCode, body: parsed };
};

// Resolve a print-lab adapter by code. Credentials come from worker env for now
// (per-org integration_configs resolution is a follow-up). Returns null when the
// lab is not configured, so the submission sweep simply skips it.
const printAdapterResolver: AdapterResolver = (labCode): PrintLabAdapter | null => {
  if (labCode === 'bayphoto' && workerEnv.PRINT_BAYPHOTO_API_KEY) {
    return new BayPhotoAdapter({
      apiKey: workerEnv.PRINT_BAYPHOTO_API_KEY,
      ...(workerEnv.PRINT_BAYPHOTO_BASE_URL ? { baseUrl: workerEnv.PRINT_BAYPHOTO_BASE_URL } : {}),
      httpClient: labHttpClient,
    });
  }
  return null;
};

const timingHttpClient: TimingHttpClient = async (method, url, headers, body) => {
  // Form-encode token requests (OAuth client-credentials), JSON otherwise.
  const isForm = headers['content-type']?.includes('x-www-form-urlencoded');
  const encodedBody =
    body === undefined
      ? undefined
      : isForm
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body);
  const res = await request(url, {
    method,
    headers,
    ...(encodedBody !== undefined ? { body: encodedBody } : {}),
    headersTimeout: WEBHOOK_TIMEOUT_MS,
    bodyTimeout: WEBHOOK_TIMEOUT_MS,
  });
  const text = await res.body.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body; keep raw text */
  }
  return { status: res.statusCode, body: parsed };
};

// Build a timing adapter from its provider + decrypted credential. The
// credential format is provider-specific (see each adapter). Unsupported
// providers return null.
const timingAdapterFactory: TimingAdapterFactory = (
  provider: TimingProvider,
  credential: string,
): TimingProviderAdapter | null => {
  if (provider === 'runsignup') {
    return new RunSignupAdapter({ apiKey: credential, httpClient: timingHttpClient });
  }
  if (provider === 'chronotrack') {
    // Credential format: "username:user_token".
    const idx = credential.indexOf(':');
    if (idx <= 0) return null;
    return new ChronoTrackAdapter({
      username: credential.slice(0, idx),
      userToken: credential.slice(idx + 1),
      httpClient: timingHttpClient,
    });
  }
  if (provider === 'mylaps') {
    // Credential format: "client_id:client_secret".
    const idx = credential.indexOf(':');
    if (idx <= 0) return null;
    return new MyLapsAdapter({
      clientId: credential.slice(0, idx),
      clientSecret: credential.slice(idx + 1),
      httpClient: timingHttpClient,
    });
  }
  return null;
};

const cloudLog = pino({ name: 'cloud-import' });

const lowerHeaders = (h: Record<string, string | string[] | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  }
  return out;
};

// JSON HTTP client for cloud listing/metadata + OAuth token refresh. Form-
// encodes token requests; surfaces response headers (for Retry-After).
const cloudHttpClient: CloudHttpClient = async (method, url, headers, body) => {
  const isForm = headers['content-type']?.includes('x-www-form-urlencoded');
  const encodedBody =
    body === undefined
      ? undefined
      : isForm
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body);
  const res = await request(url, {
    method,
    headers,
    ...(encodedBody !== undefined ? { body: encodedBody } : {}),
    headersTimeout: WEBHOOK_TIMEOUT_MS,
    bodyTimeout: WEBHOOK_TIMEOUT_MS,
  });
  const text = await res.body.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body; keep raw text */
  }
  return { status: res.statusCode, body: parsed, headers: lowerHeaders(res.headers) };
};

// Streaming downloader: returns the undici body Readable so RAW files pipe
// straight to R2 without buffering. Body timeout disabled for large files.
const cloudDownloader: CloudDownloader = async (method, url, headers) => {
  const res = await request(url, {
    method,
    headers,
    headersTimeout: WEBHOOK_TIMEOUT_MS,
    bodyTimeout: 0,
  });
  return {
    status: res.statusCode,
    stream: res.body as Readable,
    headers: lowerHeaders(res.headers),
  };
};

// Stream a download into R2 originals via multipart Upload (no full buffering).
const cloudUploader = async (params: {
  key: string;
  body: Readable;
  contentType: string;
}): Promise<void> => {
  const mod = (await import('@aws-sdk/lib-storage')) as {
    Upload: new (args: unknown) => { done: () => Promise<unknown> };
  };
  const upload = new mod.Upload({
    client: getS3(),
    params: {
      Bucket: buckets.originals,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    },
  });
  await upload.done();
};

const cloudOAuthCreds = (provider: CloudProvider): OAuthClientCredentials | null => {
  if (
    provider === 'gdrive' &&
    workerEnv.GOOGLE_OAUTH_CLIENT_ID &&
    workerEnv.GOOGLE_OAUTH_CLIENT_SECRET
  ) {
    return {
      clientId: workerEnv.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: workerEnv.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: '',
    };
  }
  if (
    provider === 'dropbox' &&
    workerEnv.DROPBOX_OAUTH_CLIENT_ID &&
    workerEnv.DROPBOX_OAUTH_CLIENT_SECRET
  ) {
    return {
      clientId: workerEnv.DROPBOX_OAUTH_CLIENT_ID,
      clientSecret: workerEnv.DROPBOX_OAUTH_CLIENT_SECRET,
      redirectUri: '',
    };
  }
  return null;
};

const cloudAdapterFactory = (provider: CloudProvider, accessToken: string): CloudStorageAdapter =>
  createCloudStorageAdapter(provider, {
    accessToken,
    httpClient: cloudHttpClient,
    downloader: cloudDownloader,
  });

// Token endpoints need the app's OAuth client creds (worker env). Throws when a
// provider is unconfigured so the import records an error instead of looping.
const cloudRefreshToken = (
  provider: CloudProvider,
  refreshTokenValue: string,
): Promise<CloudTokenSet> => {
  const creds = cloudOAuthCreds(provider);
  if (!creds) throw new Error(`oauth_not_configured:${provider}`);
  return refreshAccessToken(provider, refreshTokenValue, creds, cloudHttpClient);
};

/**
 * Wire up cron jobs and return the live handles. Caller is responsible for
 * calling .stop() on each handle during graceful shutdown.
 *
 * - Biometric retention: every 6 hours. Nightly is too lossy for the
 *   biometric SLA (a 24h window of over-retention is hard to defend under
 *   BIPA); every hour is wasteful given normal event lifecycles.
 * - Payout run: weekly, Mondays at 03:00 UTC. Cadence is fixed regardless of
 *   public holidays (locked product decision). Minimum payout = 0 (also
 *   locked). The job calls the internal API endpoint rather than importing
 *   payout logic directly so the worker stays free of API-layer deps.
 * - `protect: true` skips overlapping ticks if a previous run is still in
 *   progress — important for slow purges that span many events.
 */
export const startSchedulers = (): Cron[] => {
  const retentionJob = new Cron(
    '0 */6 * * *',
    { name: 'biometric-retention', protect: true },
    async () => {
      try {
        const result = await runRetentionPass(db, qdrant);
        log.info({ result }, 'retention pass complete');
      } catch (err) {
        log.error({ err }, 'retention pass failed');
      }
    },
  );

  // Weekly payout cron — Mondays 03:00 UTC.
  // Fixed day regardless of holidays (locked decision); no minimum (locked decision).
  const payoutJob = new Cron('0 3 * * 1', { name: 'payout-run', protect: true }, async () => {
    try {
      const result = await triggerPayoutRun();
      if (result.ok) {
        payoutLog.info({ status: result.status }, 'payout-run triggered');
      } else {
        payoutLog.error({ status: result.status }, 'payout-run trigger failed');
      }
    } catch (err) {
      payoutLog.error({ err }, 'payout-run cron error');
    }
  });

  // Takedown SLA alert: hourly sweep. Each overdue row emits a structured
  // warn log that the on-call alerting layer matches on
  // (action='takedown.sla_breach'). 24h SLA is enforced by the DB trigger.
  const slaJob = new Cron('0 * * * *', { name: 'takedown-sla-check', protect: true }, async () => {
    try {
      const result = await runTakedownSlaCheck(db, slaLog);
      slaLog.info({ overdueCount: result.overdueCount }, 'takedown sla sweep complete');
    } catch (err) {
      slaLog.error({ err }, 'takedown sla sweep failed');
    }
  });

  // BIPA retention destruction: daily at 04:00 UTC. Drops face_vectors +
  // Qdrant collections (when no other active subject still references the
  // event) and revokes consents whose statutory retention window has expired.
  const bipaJob = new Cron('0 4 * * *', { name: 'bipa-retention', protect: true }, async () => {
    try {
      const result = await runBipaRetentionDestruction(db, qdrant);
      bipaLog.info({ result }, 'bipa retention destruction complete');
    } catch (err) {
      bipaLog.error({ err }, 'bipa retention destruction failed');
    }
  });

  // Outbound webhook delivery: every minute. Picks up due deliveries and
  // performs the signed HTTP POST with retry/backoff + circuit breaking.
  // Skipped entirely until the master key is provisioned.
  const webhookJob = new Cron(
    '* * * * *',
    { name: 'webhook-delivery', protect: true },
    async () => {
      if (!workerEnv.INTEGRATIONS_MASTER_KEY) return;
      try {
        const result = await runWebhookDeliveries(db, {
          masterKey: workerEnv.INTEGRATIONS_MASTER_KEY,
          httpClient: webhookHttpClient,
        });
        if (result.processed > 0) webhookLog.info({ result }, 'webhook delivery sweep complete');
      } catch (err) {
        webhookLog.error({ err }, 'webhook delivery sweep failed');
      }
    },
  );

  // Print submission sweep: every 2 minutes. Submits pending lab orders with
  // retry/backoff; flags exhausted/terminal ones for manual intervention.
  const printSubmitJob = new Cron(
    '*/2 * * * *',
    { name: 'print-submit', protect: true },
    async () => {
      try {
        const result = await runPrintSubmissions(db, { adapterResolver: printAdapterResolver });
        if (result.processed > 0) printLog.info({ result }, 'print submission sweep complete');
      } catch (err) {
        printLog.error({ err }, 'print submission sweep failed');
      }
    },
  );

  // Print status poll: every 6h fallback for missed webhooks (manual re-poll
  // nudges next_retry_at so the next sweep re-checks sooner).
  const printPollJob = new Cron('0 */6 * * *', { name: 'print-poll', protect: true }, async () => {
    try {
      const result = await runPrintStatusPolls(db, { adapterResolver: printAdapterResolver });
      if (result.processed > 0) printLog.info({ result }, 'print status poll complete');
    } catch (err) {
      printLog.error({ err }, 'print status poll failed');
    }
  });

  // Timing sync: every 2 minutes. Pulls roster + finish events for each enabled
  // event_timing_binding and upserts participants + finish_events. Skipped until
  // the master key is provisioned (credentials cannot be decrypted otherwise).
  const timingJob = new Cron('*/2 * * * *', { name: 'timing-sync', protect: true }, async () => {
    if (!workerEnv.INTEGRATIONS_MASTER_KEY) return;
    try {
      const result = await runTimingSync(db, {
        masterKey: workerEnv.INTEGRATIONS_MASTER_KEY,
        adapterFactory: timingAdapterFactory,
      });
      if (result.bindingsProcessed > 0) timingLog.info({ result }, 'timing sync complete');
    } catch (err) {
      timingLog.error({ err }, 'timing sync failed');
    }
  });

  // Notification enqueue trigger: every 5 minutes. Calls the internal API to
  // select notifiable participants and write pending rows (the selection logic
  // lives in the API; the worker cannot import it).
  const notifyEnqueueJob = new Cron(
    '*/5 * * * *',
    { name: 'notifications-enqueue', protect: true },
    async () => {
      const res = await triggerNotificationEnqueue();
      if (!res.ok) notifyLog.warn({ status: res.status }, 'notifications enqueue trigger failed');
    },
  );

  // Notification send sweep: every minute. Sends pending notifications (email
  // always; SMS when configured + outside quiet hours). Skipped until the
  // gallery-token secret is provisioned.
  const notifySendJob = new Cron(
    '* * * * *',
    { name: 'notifications-send', protect: true },
    async () => {
      if (!workerEnv.GALLERY_TOKEN_SECRET) return;
      try {
        const result = await runNotificationSend(db, {
          galleryTokenSecret: workerEnv.GALLERY_TOKEN_SECRET,
          appBaseUrl: workerEnv.APP_BASE_URL ?? 'http://localhost:3000',
          emailSender: notificationEmailSender,
        });
        if (result.processed > 0) notifyLog.info({ result }, 'notification send sweep complete');
      } catch (err) {
        notifyLog.error({ err }, 'notification send sweep failed');
      }
    },
  );

  // Cloud import sweep: every 5 minutes. Lists bound Drive/Dropbox folders and
  // streams new files into ingest (resumable, content-hash deduped). Skipped
  // until the master key is provisioned (tokens cannot be decrypted otherwise).
  const cloudImportJob = new Cron(
    '*/5 * * * *',
    { name: 'cloud-import', protect: true },
    async () => {
      if (!workerEnv.INTEGRATIONS_MASTER_KEY) return;
      try {
        const result = await runCloudImport(db, {
          masterKey: workerEnv.INTEGRATIONS_MASTER_KEY,
          adapterFactory: cloudAdapterFactory,
          refreshToken: cloudRefreshToken,
          uploader: cloudUploader,
          ingestQueue: getIngestQueue(),
        });
        if (result.importsProcessed > 0) cloudLog.info({ result }, 'cloud import sweep complete');
      } catch (err) {
        cloudLog.error({ err }, 'cloud import sweep failed');
      }
    },
  );

  return [
    retentionJob,
    payoutJob,
    slaJob,
    bipaJob,
    webhookJob,
    printSubmitJob,
    printPollJob,
    timingJob,
    notifyEnqueueJob,
    notifySendJob,
    cloudImportJob,
  ];
};
