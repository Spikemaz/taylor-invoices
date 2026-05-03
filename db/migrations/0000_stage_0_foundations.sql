CREATE TYPE "public"."entity_type" AS ENUM('sole_trader', 'limited', 'partnership', 'other');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('pending', 'running', 'done', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending', 'active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."vat_scheme" AS ENUM('none', 'standard', 'flat_rate', 'cash');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_email" text,
	"actor_role" text,
	"on_behalf_of_user_id" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"entity_id" text,
	"ip" text,
	"user_agent" text,
	"request_id" text,
	"before" jsonb,
	"after" jsonb,
	"diff" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "entity_type" NOT NULL,
	"trading_name" text,
	"company_number" text,
	"utr" text,
	"vat_number" text,
	"vat_scheme" "vat_scheme" DEFAULT 'none' NOT NULL,
	"default_currency" text DEFAULT 'GBP' NOT NULL,
	"fiscal_year_end" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_locks" (
	"kind" text PRIMARY KEY NOT NULL,
	"locked_at" timestamp with time zone NOT NULL,
	"locked_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "job_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"result" jsonb,
	"user_id" text,
	"entity_id" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'pending' NOT NULL,
	"sheet_id" text,
	"drive_folder_id" text,
	"backup_sheet_id" text,
	"backup_folder_id" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_actor_ts_idx" ON "audit_log" USING btree ("actor_user_id","ts");--> statement-breakpoint
CREATE INDEX "audit_log_resource_ts_idx" ON "audit_log" USING btree ("resource_type","resource_id","ts");--> statement-breakpoint
CREATE INDEX "audit_log_entity_ts_idx" ON "audit_log" USING btree ("entity_id","ts");--> statement-breakpoint
CREATE INDEX "audit_log_action_ts_idx" ON "audit_log" USING btree ("action","ts");--> statement-breakpoint
CREATE INDEX "entities_user_idx" ON "entities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "jobs_pick_idx" ON "jobs" USING btree ("state","scheduled_for");--> statement-breakpoint
CREATE INDEX "jobs_kind_state_idx" ON "jobs" USING btree ("kind","state");--> statement-breakpoint
CREATE INDEX "jobs_user_idx" ON "jobs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "magic_links_email_idx" ON "magic_links" USING btree ("email","expires_at");--> statement-breakpoint
CREATE INDEX "rate_limits_expires_idx" ON "rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");