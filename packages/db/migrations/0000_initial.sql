CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE TYPE "app"."kyc_status" AS ENUM('unstarted', 'pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "app"."org_member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "app"."user_role" AS ENUM('superadmin', 'admin', 'photographer', 'organizer', 'assistant', 'attendee');--> statement-breakpoint
CREATE TYPE "app"."user_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "app"."event_member_role" AS ENUM('organizer', 'photographer', 'assistant');--> statement-breakpoint
CREATE TYPE "app"."event_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "app"."derivative_kind" AS ENUM('thumb', 'preview', 'web', 'full');--> statement-breakpoint
CREATE TYPE "app"."photo_status" AS ENUM('processing', 'ready', 'hidden', 'failed', 'takedown');--> statement-breakpoint
CREATE TYPE "app"."upload_session_status" AS ENUM('in_progress', 'completed', 'aborted', 'expired');--> statement-breakpoint
CREATE TYPE "app"."bib_source" AS ENUM('ocr', 'manual', 'roster_match');--> statement-breakpoint
CREATE TYPE "app"."match_feedback" AS ENUM('unrated', 'correct', 'wrong', 'missing');--> statement-breakpoint
CREATE TYPE "app"."match_source" AS ENUM('bib', 'name', 'face', 'text', 'hybrid');--> statement-breakpoint
CREATE TYPE "app"."quality_flag_kind" AS ENUM('blur', 'eyes_closed', 'near_duplicate', 'underexposed', 'overexposed');--> statement-breakpoint
CREATE TYPE "app"."search_kind" AS ENUM('bib', 'name', 'face', 'text');--> statement-breakpoint
CREATE TYPE "app"."product_kind" AS ENUM('digital_single', 'digital_bundle', 'foto_flat', 'print');--> statement-breakpoint
CREATE TYPE "app"."cart_status" AS ENUM('active', 'converted', 'expired', 'abandoned');--> statement-breakpoint
CREATE TYPE "app"."fulfillment_kind" AS ENUM('digital_download', 'print');--> statement-breakpoint
CREATE TYPE "app"."fulfillment_status" AS ENUM('pending', 'in_progress', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."order_status" AS ENUM('pending_payment', 'paid', 'partially_refunded', 'refunded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."audit_actor_kind" AS ENUM('user', 'system', 'cron', 'admin', 'webhook');--> statement-breakpoint
CREATE TYPE "app"."consent_jurisdiction" AS ENUM('eu_gdpr', 'br_lgpd', 'us_bipa', 'us_ccpa', 'other');--> statement-breakpoint
CREATE TYPE "app"."consent_scope" AS ENUM('biometric', 'marketing', 'terms_of_service', 'privacy_policy');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."organization_members" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "app"."org_member_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."photographer_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"website_url" text,
	"stripe_account_id" text,
	"kyc_status" "app"."kyc_status" DEFAULT 'unstarted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"email_verified_at" timestamp with time zone,
	"display_name" text,
	"role" "app"."user_role" DEFAULT 'attendee' NOT NULL,
	"status" "app"."user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."event_ftp_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_ftp_credentials_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."event_members" (
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "app"."event_member_role" NOT NULL,
	"split_pct" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_members_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."event_roster_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"bib" text NOT NULL,
	"name" text,
	"email_lower" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."event_settings" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"watermark_text" text,
	"watermark_opacity" numeric(3, 2) DEFAULT '0.40' NOT NULL,
	"preview_max_pixels" integer DEFAULT 1600 NOT NULL,
	"download_expiry_hours" integer DEFAULT 72 NOT NULL,
	"face_threshold" numeric(3, 2) DEFAULT '0.45' NOT NULL,
	"allow_anonymous_browse" boolean DEFAULT true NOT NULL,
	"hide_buy_button" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"event_date" date NOT NULL,
	"location" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"status" "app"."event_status" DEFAULT 'draft' NOT NULL,
	"allow_face_search" boolean DEFAULT true NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"cover_photo_id" uuid,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."photo_derivatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"kind" "app"."derivative_kind" NOT NULL,
	"object_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"watermarked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"photographer_user_id" uuid NOT NULL,
	"upload_session_id" uuid,
	"original_object_key" text NOT NULL,
	"original_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"width" integer,
	"height" integer,
	"captured_at" timestamp with time zone,
	"exif_jsonb" jsonb,
	"status" "app"."photo_status" DEFAULT 'processing' NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"takedown_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"photographer_user_id" uuid NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"total_bytes" bigint NOT NULL,
	"r2_upload_id" text NOT NULL,
	"r2_object_key" text NOT NULL,
	"chunks_received" integer DEFAULT 0 NOT NULL,
	"chunk_size_bytes" integer NOT NULL,
	"status" "app"."upload_session_status" DEFAULT 'in_progress' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."bib_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"bib_number" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"source" "app"."bib_source" DEFAULT 'ocr' NOT NULL,
	"bbox_jsonb" jsonb,
	"model_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."face_vectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"bbox_x" integer NOT NULL,
	"bbox_y" integer NOT NULL,
	"bbox_width" integer NOT NULL,
	"bbox_height" integer NOT NULL,
	"detector_score" numeric(4, 3) NOT NULL,
	"qdrant_point_id" text NOT NULL,
	"model_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."quality_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"flag" "app"."quality_flag_kind" NOT NULL,
	"score" numeric(4, 3) NOT NULL,
	"metadata_jsonb" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."search_matches" (
	"session_id" uuid NOT NULL,
	"photo_id" uuid NOT NULL,
	"score" numeric(5, 4) NOT NULL,
	"source" "app"."match_source" NOT NULL,
	"rank" integer NOT NULL,
	"feedback" "app"."match_feedback" DEFAULT 'unrated' NOT NULL,
	CONSTRAINT "search_matches_session_id_photo_id_pk" PRIMARY KEY("session_id","photo_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."search_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"search_kind" "app"."search_kind" NOT NULL,
	"query_text" text,
	"matches_count" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"client_ip_hash" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."license_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "app"."product_kind" NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"license_tier_id" uuid NOT NULL,
	"config_jsonb" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"photo_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"photo_id" uuid,
	"license_tier_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_quantity_positive" CHECK ("app"."cart_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anonymous_token" text NOT NULL,
	"user_id" uuid,
	"event_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"status" "app"."cart_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"converted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_anonymous_token_unique" UNIQUE("anonymous_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" "app"."fulfillment_kind" NOT NULL,
	"status" "app"."fulfillment_status" DEFAULT 'pending' NOT NULL,
	"download_token" text,
	"download_expires_at" timestamp with time zone,
	"lab_partner" text,
	"lab_external_id" text,
	"tracking_number" text,
	"tracking_url" text,
	"payload_jsonb" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillments_download_token_unique" UNIQUE("download_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"photo_id" uuid,
	"license_tier_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"line_total_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"metadata_jsonb" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"buyer_email" text NOT NULL,
	"buyer_user_id" uuid,
	"subtotal_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"stripe_payment_intent_id" text,
	"stripe_charge_id" text,
	"status" "app"."order_status" DEFAULT 'pending_payment' NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_cart_id_unique" UNIQUE("cart_id"),
	CONSTRAINT "orders_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" uuid,
	"actor_kind" "app"."audit_actor_kind" NOT NULL,
	"action" text NOT NULL,
	"target_kind" text,
	"target_id" text,
	"event_id" uuid,
	"ip_hash" text,
	"user_agent" text,
	"payload_jsonb" jsonb,
	"payload_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app"."consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "app"."consent_scope" NOT NULL,
	"subject_id" uuid,
	"subject_email_hash" text,
	"event_id" uuid,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"retention_until" timestamp with time zone,
	"jurisdiction" "app"."consent_jurisdiction" NOT NULL,
	"evidence_jsonb" jsonb NOT NULL,
	"consent_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."organization_members" ADD CONSTRAINT "organization_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."organizations" ADD CONSTRAINT "organizations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."photographer_profiles" ADD CONSTRAINT "photographer_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."event_ftp_credentials" ADD CONSTRAINT "event_ftp_credentials_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "app"."events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."event_members" ADD CONSTRAINT "event_members_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "app"."events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."event_roster_entries" ADD CONSTRAINT "event_roster_entries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "app"."events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."event_settings" ADD CONSTRAINT "event_settings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "app"."events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."photo_derivatives" ADD CONSTRAINT "photo_derivatives_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "app"."photos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."photos" ADD CONSTRAINT "photos_upload_session_id_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "app"."upload_sessions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."search_matches" ADD CONSTRAINT "search_matches_session_id_search_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "app"."search_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."products" ADD CONSTRAINT "products_license_tier_id_license_tiers_id_fk" FOREIGN KEY ("license_tier_id") REFERENCES "app"."license_tiers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "app"."carts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."fulfillments" ADD CONSTRAINT "fulfillments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "app"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "app"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "app"."carts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_idx" ON "app"."organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_active_idx" ON "app"."sessions" USING btree ("user_id","revoked_at","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_refresh_token_hash_idx" ON "app"."sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_idx" ON "app"."users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_ftp_credentials_lookup_idx" ON "app"."event_ftp_credentials" USING btree ("event_id","revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_members_user_idx" ON "app"."event_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_roster_entries_event_bib_unique" ON "app"."event_roster_entries" USING btree ("event_id","bib");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_roster_entries_event_email_idx" ON "app"."event_roster_entries" USING btree ("event_id","email_lower");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_org_slug_unique" ON "app"."events" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_status_date_idx" ON "app"."events" USING btree ("status","event_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "photo_derivatives_photo_kind_idx" ON "app"."photo_derivatives" USING btree ("photo_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photos_event_list_idx" ON "app"."photos" USING btree ("event_id","status","hidden","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photos_event_captured_at_idx" ON "app"."photos" USING btree ("event_id","captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photos_photographer_event_idx" ON "app"."photos" USING btree ("photographer_user_id","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_event_status_idx" ON "app"."upload_sessions" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_gc_idx" ON "app"."upload_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bib_tags_event_bib_idx" ON "app"."bib_tags" USING btree ("event_id","bib_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bib_tags_photo_idx" ON "app"."bib_tags" USING btree ("photo_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "face_vectors_qdrant_point_id_idx" ON "app"."face_vectors" USING btree ("qdrant_point_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "face_vectors_event_idx" ON "app"."face_vectors" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "face_vectors_photo_idx" ON "app"."face_vectors" USING btree ("photo_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quality_flags_photo_flag_idx" ON "app"."quality_flags" USING btree ("photo_id","flag");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_matches_photo_source_idx" ON "app"."search_matches" USING btree ("photo_id","source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_sessions_event_created_idx" ON "app"."search_sessions" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_sessions_consent_idx" ON "app"."search_sessions" USING btree ("consent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "license_tiers_code_unique" ON "app"."license_tiers" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_sku_unique" ON "app"."products" USING btree ("sku");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_event_kind_active_idx" ON "app"."products" USING btree ("event_id","kind","active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_photo_idx" ON "app"."products" USING btree ("photo_id") WHERE "app"."products"."photo_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_event_photo_kind_license_unique" ON "app"."products" USING btree ("event_id","photo_id","kind","license_tier_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cart_items_cart_line_idx" ON "app"."cart_items" USING btree ("cart_id","product_id","photo_id","license_tier_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "carts_event_status_idx" ON "app"."carts" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "carts_gc_idx" ON "app"."carts" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillments_order_kind_idx" ON "app"."fulfillments" USING btree ("order_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillments_download_token_idx" ON "app"."fulfillments" USING btree ("download_token") WHERE "app"."fulfillments"."download_token" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_order_idx" ON "app"."order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_photo_idx" ON "app"."order_items" USING btree ("photo_id") WHERE "app"."order_items"."photo_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_event_status_placed_idx" ON "app"."orders" USING btree ("event_id","status","placed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_buyer_email_placed_idx" ON "app"."orders" USING btree ("buyer_email","placed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_stripe_payment_intent_idx" ON "app"."orders" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_action_created_at_idx" ON "app"."audit_log" USING btree ("action","created_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_event_created_at_idx" ON "app"."audit_log" USING btree ("event_id","created_at" desc) WHERE "app"."audit_log"."event_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_created_at_idx" ON "app"."audit_log" USING btree ("actor_user_id","created_at" desc) WHERE "app"."audit_log"."actor_user_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_target_idx" ON "app"."audit_log" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "consents_active_subject_scope_event_idx" ON "app"."consents" USING btree ("subject_id","scope","event_id") WHERE "app"."consents"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consents_email_hash_scope_idx" ON "app"."consents" USING btree ("subject_email_hash","scope") WHERE "app"."consents"."subject_email_hash" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consents_retention_until_idx" ON "app"."consents" USING btree ("retention_until") WHERE "app"."consents"."retention_until" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consents_event_scope_idx" ON "app"."consents" USING btree ("event_id","scope") WHERE "app"."consents"."event_id" is not null;