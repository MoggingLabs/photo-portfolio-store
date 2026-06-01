-- M4 Wave 4 — F4.12 "Photos are ready" notifications.

CREATE TYPE "app"."notification_channel" AS ENUM ('email', 'sms');
CREATE TYPE "app"."notification_status" AS ENUM ('pending', 'sent', 'failed', 'skipped', 'suppressed');

ALTER TABLE "app"."participants" ADD COLUMN "sms_opt_in" boolean NOT NULL DEFAULT false;
ALTER TABLE "app"."participants" ADD COLUMN "locale" text;

CREATE TABLE "app"."participant_notifications" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "participant_id"       uuid NOT NULL,                          -- refs participants.id (cross-context)
  "event_id"             uuid NOT NULL,
  "channel"              "app"."notification_channel" NOT NULL,
  "template"             text NOT NULL,
  "status"               "app"."notification_status" NOT NULL DEFAULT 'pending',
  "provider_message_id"  text,
  -- The 30-minute digest window this notification belongs to (idempotency key).
  "dispatch_window_start" timestamp with time zone NOT NULL,
  "sent_at"              timestamp with time zone,
  "last_error"          text,
  "payload_json"        jsonb,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now()
);

-- One notification per participant/event/channel per digest window.
CREATE UNIQUE INDEX "participant_notifications_window_idx"
  ON "app"."participant_notifications" ("participant_id", "event_id", "channel", "dispatch_window_start");
CREATE INDEX "participant_notifications_lookup_idx"
  ON "app"."participant_notifications" ("participant_id", "event_id", "channel");
-- Worker send sweep: pending rows.
CREATE INDEX "participant_notifications_status_idx"
  ON "app"."participant_notifications" ("status", "created_at");

-- Bounce / complaint suppression list. address is lowercased email or E.164 phone.
CREATE TABLE "app"."notification_suppressions" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel"    "app"."notification_channel" NOT NULL,
  "address"    text NOT NULL,
  "reason"     text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "notification_suppressions_channel_address_idx"
  ON "app"."notification_suppressions" ("channel", "address");
