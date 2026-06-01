-- M4 Wave 3 — F4.8 MyLaps: participants gain an optional transponder id.

ALTER TABLE "app"."participants" ADD COLUMN "transponder_id" text;

CREATE INDEX "participants_event_transponder_idx"
  ON "app"."participants" ("event_id", "transponder_id")
  WHERE "transponder_id" IS NOT NULL;
