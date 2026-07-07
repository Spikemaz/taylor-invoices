CREATE TYPE "public"."accountant_access_scope" AS ENUM('read_only', 'full');--> statement-breakpoint
CREATE TYPE "public"."accountant_access_status" AS ENUM('pending', 'accepted', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."report_snapshot_kind" AS ENUM('profit_and_loss', 'balance_sheet', 'trial_balance', 'cash_flow', 'aged_debtors', 'aged_creditors', 'vat_detail', 'directors_report');--> statement-breakpoint
CREATE TABLE "accountant_access" (
"id" text PRIMARY KEY NOT NULL,
"client_user_id" text NOT NULL,
"accountant_email" text NOT NULL,
"accountant_user_id" text,
"scope" "accountant_access_scope" DEFAULT 'read_only' NOT NULL,
"status" "accountant_access_status" DEFAULT 'pending' NOT NULL,
"invite_token_hash" text,
"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
"accepted_at" timestamp with time zone,
"revoked_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "year_end_checklists" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"fiscal_year" integer NOT NULL,
"period_id" text,
"steps" jsonb NOT NULL,
"locked_at" timestamp with time zone,
"locked_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "report_snapshots" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"kind" "report_snapshot_kind" NOT NULL,
"period_start" date NOT NULL,
"period_end" date NOT NULL,
"fiscal_year" integer,
"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
"generated_by" text,
"payload" jsonb NOT NULL
);--> statement-breakpoint
ALTER TABLE "accountant_access" ADD CONSTRAINT "accountant_access_client_user_id_users_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accountant_access" ADD CONSTRAINT "accountant_access_accountant_user_id_users_id_fk" FOREIGN KEY ("accountant_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_checklists" ADD CONSTRAINT "year_end_checklists_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accountant_access_client_email_uq" ON "accountant_access" ("client_user_id","accountant_email");--> statement-breakpoint
CREATE INDEX "accountant_access_client_idx" ON "accountant_access" ("client_user_id");--> statement-breakpoint
CREATE INDEX "accountant_access_accountant_idx" ON "accountant_access" ("accountant_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "year_end_checklists_entity_year_uq" ON "year_end_checklists" ("entity_id","fiscal_year");--> statement-breakpoint
CREATE INDEX "report_snapshots_entity_kind_end_idx" ON "report_snapshots" ("entity_id","kind","period_end");
