-- vat_scheme already exists from 0000_stage_0_foundations.sql (with
-- 'none' + standard/flat_rate/cash). Reused here as-is.
CREATE TYPE "public"."vat_return_status" AS ENUM('draft', 'submitted', 'locked');--> statement-breakpoint
CREATE TYPE "public"."vat_obligation_status" AS ENUM('open', 'fulfilled');--> statement-breakpoint
CREATE TYPE "public"."vat_box_side" AS ENUM('output', 'input', 'eu_acquisition', 'eu_dispatch');--> statement-breakpoint
CREATE TABLE "vat_registrations" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"vat_number" text NOT NULL,
"scheme" "vat_scheme" DEFAULT 'standard' NOT NULL,
"cash_accounting" boolean DEFAULT false NOT NULL,
"flat_rate_scheme" jsonb,
"registration_date" date NOT NULL,
"deregistration_date" date,
"archived" boolean DEFAULT false NOT NULL,
"notes" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vat_returns" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"vat_registration_id" text NOT NULL,
"period_key" text NOT NULL,
"period_start" date NOT NULL,
"period_end" date NOT NULL,
"scheme_at_submit" "vat_scheme" NOT NULL,
"cash_basis" boolean DEFAULT false NOT NULL,
"boxes" jsonb NOT NULL,
"status" "vat_return_status" DEFAULT 'draft' NOT NULL,
"submitted_at" timestamp with time zone,
"hmrc_receipt" jsonb,
"signed_by_user_id" text,
"signed_at" timestamp with time zone,
"notes" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vat_obligations" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"period_key" text NOT NULL,
"period_start" date NOT NULL,
"period_end" date NOT NULL,
"due_date" date NOT NULL,
"status" "vat_obligation_status" DEFAULT 'open' NOT NULL,
"received_at" timestamp with time zone,
"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_line_vat" (
"id" bigserial PRIMARY KEY NOT NULL,
"journal_line_id" bigint NOT NULL,
"entity_id" text NOT NULL,
"side" "vat_box_side" NOT NULL,
"vat_rate_pct" numeric(5,2) NOT NULL,
"net_pence" bigint NOT NULL,
"vat_pence" bigint NOT NULL,
"gross_pence" bigint NOT NULL,
"locked_by_return_id" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vat_registrations" ADD CONSTRAINT "vat_registrations_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_returns" ADD CONSTRAINT "vat_returns_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_returns" ADD CONSTRAINT "vat_returns_vat_registration_id_vat_registrations_id_fk" FOREIGN KEY ("vat_registration_id") REFERENCES "public"."vat_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_obligations" ADD CONSTRAINT "vat_obligations_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_vat" ADD CONSTRAINT "journal_line_vat_journal_line_id_journal_lines_id_fk" FOREIGN KEY ("journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_vat" ADD CONSTRAINT "journal_line_vat_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vat_registrations_entity_idx" ON "vat_registrations" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vat_registrations_entity_vrn_uq" ON "vat_registrations" USING btree ("entity_id","vat_number");--> statement-breakpoint
CREATE UNIQUE INDEX "vat_returns_entity_period_uq" ON "vat_returns" USING btree ("entity_id","period_key");--> statement-breakpoint
CREATE INDEX "vat_returns_entity_range_idx" ON "vat_returns" USING btree ("entity_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "vat_obligations_entity_period_uq" ON "vat_obligations" USING btree ("entity_id","period_key");--> statement-breakpoint
CREATE INDEX "vat_obligations_entity_due_idx" ON "vat_obligations" USING btree ("entity_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_line_vat_line_uq" ON "journal_line_vat" USING btree ("journal_line_id");--> statement-breakpoint
CREATE INDEX "journal_line_vat_entity_idx" ON "journal_line_vat" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "journal_line_vat_locked_idx" ON "journal_line_vat" USING btree ("locked_by_return_id");
