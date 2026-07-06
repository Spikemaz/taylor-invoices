-- Stage 9 — Invoicing polish: contacts, invoices, quotes, recurring,
-- payment links, reminders, multi-currency.
--
-- All tables are env-gated behind the existing isPostgresEnabled() /
-- isDualWriteEnabled() flags via the libs that touch them. The live
-- Sheets-backed booksiq.app site is untouched by this migration.

CREATE TYPE "public"."contact_type" AS ENUM('customer', 'supplier', 'both');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'partially_paid', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'sent', 'accepted', 'declined', 'expired', 'converted');--> statement-breakpoint
CREATE TYPE "public"."recurring_frequency" AS ENUM('weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."recurring_status" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."payment_link_provider" AS ENUM('stripe', 'gocardless');--> statement-breakpoint
CREATE TYPE "public"."payment_link_status" AS ENUM('pending', 'processing', 'succeeded', 'failed', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."reminder_trigger" AS ENUM('before_due', 'on_due', 'after_due');--> statement-breakpoint

CREATE TABLE "contacts" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"type" "contact_type" DEFAULT 'customer' NOT NULL,
"name" text NOT NULL,
"email" text,
"phone" text,
"address_line_1" text,
"address_line_2" text,
"city" text,
"postcode" text,
"country" text DEFAULT 'GB' NOT NULL,
"default_currency" text DEFAULT 'GBP' NOT NULL,
"payment_terms_days" integer DEFAULT 30 NOT NULL,
"notes" text,
"archived" boolean DEFAULT false NOT NULL,
"created_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "invoices" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"contact_id" text,
"invoice_number" text NOT NULL,
"status" "invoice_status" DEFAULT 'draft' NOT NULL,
"issue_date" date NOT NULL,
"due_date" date NOT NULL,
"currency" text DEFAULT 'GBP' NOT NULL,
"fx_rate_to_base" numeric(18, 8) DEFAULT '1' NOT NULL,
"subtotal_pence" bigint NOT NULL,
"total_pence" bigint NOT NULL,
"total_base_pence" bigint NOT NULL,
"paid_pence" bigint DEFAULT 0 NOT NULL,
"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
"notes" text,
"journal_id" text,
"quote_id" text,
"recurring_id" text,
"sent_at" timestamp with time zone,
"paid_at" timestamp with time zone,
"voided_at" timestamp with time zone,
"created_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "quotes" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"contact_id" text,
"quote_number" text NOT NULL,
"status" "quote_status" DEFAULT 'draft' NOT NULL,
"issue_date" date NOT NULL,
"expiry_date" date,
"currency" text DEFAULT 'GBP' NOT NULL,
"fx_rate_to_base" numeric(18, 8) DEFAULT '1' NOT NULL,
"total_pence" bigint NOT NULL,
"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
"notes" text,
"accept_token_hash" text,
"accepted_at" timestamp with time zone,
"converted_invoice_id" text,
"created_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "recurring_invoices" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"contact_id" text NOT NULL,
"frequency" "recurring_frequency" NOT NULL,
"status" "recurring_status" DEFAULT 'active' NOT NULL,
"start_date" date NOT NULL,
"end_date" date,
"next_run_date" date NOT NULL,
"payment_terms_days" integer DEFAULT 30 NOT NULL,
"currency" text DEFAULT 'GBP' NOT NULL,
"total_pence" bigint NOT NULL,
"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
"notes" text,
"last_generated_at" timestamp with time zone,
"generated_count" integer DEFAULT 0 NOT NULL,
"created_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "payment_links" (
"id" text PRIMARY KEY NOT NULL,
"invoice_id" text NOT NULL,
"provider" "payment_link_provider" NOT NULL,
"provider_ref" text NOT NULL,
"status" "payment_link_status" DEFAULT 'pending' NOT NULL,
"amount_pence" bigint NOT NULL,
"currency" text DEFAULT 'GBP' NOT NULL,
"succeeded_at" timestamp with time zone,
"last_event_id" text,
"payment_journal_id" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "payment_link_events" (
"id" text PRIMARY KEY NOT NULL,
"payment_link_id" text NOT NULL,
"provider" "payment_link_provider" NOT NULL,
"event_id" text NOT NULL,
"event_type" text NOT NULL,
"payload" jsonb NOT NULL,
"received_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "reminder_rules" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"name" text NOT NULL,
"trigger" "reminder_trigger" NOT NULL,
"days_offset" integer DEFAULT 0 NOT NULL,
"template_subject" text NOT NULL,
"template_body" text NOT NULL,
"active" boolean DEFAULT true NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "reminder_log" (
"id" text PRIMARY KEY NOT NULL,
"invoice_id" text NOT NULL,
"rule_id" text NOT NULL,
"scheduled_for" date NOT NULL,
"sent_at" timestamp with time zone,
"channel" text DEFAULT 'email' NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "contacts" ADD CONSTRAINT "contacts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_events" ADD CONSTRAINT "payment_link_events_payment_link_id_payment_links_id_fk" FOREIGN KEY ("payment_link_id") REFERENCES "public"."payment_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_rules" ADD CONSTRAINT "reminder_rules_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_log" ADD CONSTRAINT "reminder_log_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_log" ADD CONSTRAINT "reminder_log_rule_id_reminder_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."reminder_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "contacts_entity_name_idx" ON "contacts" ("entity_id","name");--> statement-breakpoint
CREATE INDEX "contacts_entity_type_idx" ON "contacts" ("entity_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_entity_number_uq" ON "invoices" ("entity_id","invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_entity_status_idx" ON "invoices" ("entity_id","status");--> statement-breakpoint
CREATE INDEX "invoices_contact_idx" ON "invoices" ("contact_id");--> statement-breakpoint
CREATE INDEX "invoices_entity_due_idx" ON "invoices" ("entity_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_entity_number_uq" ON "quotes" ("entity_id","quote_number");--> statement-breakpoint
CREATE INDEX "quotes_entity_status_idx" ON "quotes" ("entity_id","status");--> statement-breakpoint
CREATE INDEX "quotes_accept_token_idx" ON "quotes" ("accept_token_hash");--> statement-breakpoint
CREATE INDEX "recurring_invoices_entity_status_idx" ON "recurring_invoices" ("entity_id","status");--> statement-breakpoint
CREATE INDEX "recurring_invoices_next_run_idx" ON "recurring_invoices" ("status","next_run_date");--> statement-breakpoint
CREATE INDEX "payment_links_invoice_idx" ON "payment_links" ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_provider_ref_uq" ON "payment_links" ("provider","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_link_events_provider_event_uq" ON "payment_link_events" ("provider","event_id");--> statement-breakpoint
CREATE INDEX "payment_link_events_link_idx" ON "payment_link_events" ("payment_link_id");--> statement-breakpoint
CREATE INDEX "reminder_rules_entity_active_idx" ON "reminder_rules" ("entity_id","active");--> statement-breakpoint
CREATE INDEX "reminder_log_invoice_idx" ON "reminder_log" ("invoice_id");--> statement-breakpoint
CREATE INDEX "reminder_log_rule_scheduled_idx" ON "reminder_log" ("rule_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_log_invoice_rule_sched_uq" ON "reminder_log" ("invoice_id","rule_id","scheduled_for");
