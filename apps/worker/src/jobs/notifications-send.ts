// F4.12 — notification send sweep.
//
// Sends pending participant_notifications. Email always; SMS only when a sender
// is configured and the recipient is outside quiet hours (otherwise the row is
// left pending and retried on a later sweep, after 8am local). Each email
// carries a signed 24h gallery deep-link. Senders are injectable so the sweep
// is unit-testable without a live provider.

import { type DbClient, schema } from '@pkg/db';
import { isQuietHours, signGalleryToken } from '@pkg/integrations';
import { eq, inArray } from 'drizzle-orm';

const { participantNotifications } = schema.notifications;

const BATCH_LIMIT = 200;

export interface EmailSendResult {
  messageId?: string;
}
export type EmailSender = (msg: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<EmailSendResult>;
export type SmsSender = (msg: { to: string; body: string }) => Promise<EmailSendResult>;

export interface NotificationSendDeps {
  galleryTokenSecret: string;
  appBaseUrl: string;
  emailSender: EmailSender;
  smsSender?: SmsSender;
  now?: () => Date;
}

export interface SendResult {
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  deferred: number;
}

interface NotifPayload {
  email?: string;
  phone?: string;
  locale?: string | null;
  eventId: string;
  eventName: string;
  participantId: string;
  matchedPhotos: number;
}

interface PendingRow {
  id: string;
  channel: 'email' | 'sms';
  template: string;
  payloadJson: unknown;
}

const subjectFor = (template: string, eventName: string): string =>
  template === 'photos_more_added'
    ? `More photos from ${eventName} are ready`
    : `Your photos from ${eventName} are ready`;

const bodyFor = (
  template: string,
  eventName: string,
  url: string,
): { html: string; text: string } => {
  const lead =
    template === 'photos_more_added'
      ? `More of your photos from ${eventName} are ready to view.`
      : `Your photos from ${eventName} are ready to view.`;
  return {
    text: `${lead}\n\nView your gallery: ${url}`,
    html: `<p>${lead}</p><p><a href="${url}">View your gallery</a></p>`,
  };
};

export const runNotificationSend = async (
  db: DbClient,
  deps: NotificationSendDeps,
): Promise<SendResult> => {
  const now = deps.now ?? (() => new Date());
  const rows = (await db
    .select({
      id: participantNotifications.id,
      channel: participantNotifications.channel,
      template: participantNotifications.template,
      payloadJson: participantNotifications.payloadJson,
    })
    .from(participantNotifications)
    .where(inArray(participantNotifications.status, ['pending']))
    .limit(BATCH_LIMIT)) as PendingRow[];

  const result: SendResult = { processed: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 };

  for (const row of rows) {
    result.processed += 1;
    const payload = (row.payloadJson ?? {}) as NotifPayload;
    const token = signGalleryToken(payload.participantId, payload.eventId, deps.galleryTokenSecret);
    const url = `${deps.appBaseUrl.replace(/\/$/, '')}/g/${token}`;

    try {
      if (row.channel === 'sms') {
        if (!deps.smsSender) {
          await mark(db, row.id, 'skipped', { error: 'sms_not_configured' });
          result.skipped += 1;
          continue;
        }
        if (isQuietHours(now(), payload.locale)) {
          result.deferred += 1; // leave pending; a later sweep (after 8am) sends it
          continue;
        }
        if (!payload.phone) {
          await mark(db, row.id, 'skipped', { error: 'no_phone' });
          result.skipped += 1;
          continue;
        }
        const sms = await deps.smsSender({
          to: payload.phone,
          body: `${subjectFor(row.template, payload.eventName)}: ${url}`,
        });
        await mark(db, row.id, 'sent', { messageId: sms.messageId, now: now() });
        result.sent += 1;
      } else {
        if (!payload.email) {
          await mark(db, row.id, 'skipped', { error: 'no_email' });
          result.skipped += 1;
          continue;
        }
        const { html, text } = bodyFor(row.template, payload.eventName, url);
        const email = await deps.emailSender({
          to: payload.email,
          subject: subjectFor(row.template, payload.eventName),
          html,
          text,
        });
        await mark(db, row.id, 'sent', { messageId: email.messageId, now: now() });
        result.sent += 1;
      }
    } catch (err) {
      await mark(db, row.id, 'failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      result.failed += 1;
    }
  }

  return result;
};

const mark = (
  db: DbClient,
  id: string,
  status: 'sent' | 'failed' | 'skipped',
  opts: { messageId?: string; error?: string; now?: Date },
): Promise<unknown> =>
  db
    .update(participantNotifications)
    .set({
      status,
      ...(opts.messageId ? { providerMessageId: opts.messageId } : {}),
      ...(opts.error ? { lastError: opts.error } : {}),
      ...(status === 'sent' ? { sentAt: opts.now ?? new Date() } : {}),
    })
    .where(eq(participantNotifications.id, id));
