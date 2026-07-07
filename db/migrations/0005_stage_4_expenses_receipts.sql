CREATE TYPE "public"."receipt_status" AS ENUM('pending', 'ocr_done', 'approved', 'rejected', 'matched');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('bank', 'cash', 'director');--> statement-breakpoint
CREATE TYPE "public"."vehicle_type" AS ENUM('car', 'motorbike', 'bike');--> statement-breakpoint
CREATE TYPE "public"."journey_type" AS ENUM('business', 'commute', 'personal');--> statement-breakpoint
CREATE TYPE "public"."expense_claim_status" AS ENUM('draft', 'submitted', 'approved', 'rejected', 'paid');--> statement-breakpoint
CREATE TABLE "receipts" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"file_id" text,
"file_url" text,
"file_name" text,
"mime_type" text,
"vendor" text,
"receipt_date" date,
"currency" text DEFAULT 'GBP' NOT NULL,
"total_pence" bigint,
"vat_pence" bigint,
"net_pence" bigint,
"payment_method" "payment_method" DEFAULT 'bank' NOT NULL,
"expense_account_code" text,
"ocr_payload" jsonb,
"ocr_confidence" integer,
"ocr_model" text,
"status" "receipt_status" DEFAULT 'pending' NOT NULL,
"posted_journal_id" text,
"matched_bank_tx_id" text,
"notes" text,
"created_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mileage_logs" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"journey_date" date NOT NULL,
"tax_year" integer NOT NULL,
"from_address" text NOT NULL,
"to_address" text NOT NULL,
"distance_miles_x100" integer NOT NULL,
"vehicle_type" "vehicle_type" NOT NULL,
"journey_type" "journey_type" DEFAULT 'business' NOT NULL,
"rate_pence_per_mile" integer NOT NULL,
"portion_at_full_rate_miles_x100" integer DEFAULT 0 NOT NULL,
"portion_at_taper_rate_miles_x100" integer DEFAULT 0 NOT NULL,
"full_rate_pence_per_mile" integer,
"taper_rate_pence_per_mile" integer,
"amount_pence" bigint NOT NULL,
"notes" text,
"posted_journal_id" text,
"created_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_claims" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"claimant_user_id" text,
"title" text NOT NULL,
"claim_date" date NOT NULL,
"total_pence" bigint DEFAULT 0 NOT NULL,
"status" "expense_claim_status" DEFAULT 'draft' NOT NULL,
"posted_journal_id" text,
"notes" text,
"created_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_claim_items" (
"id" text PRIMARY KEY NOT NULL,
"claim_id" text NOT NULL,
"receipt_id" text,
"description" text NOT NULL,
"amount_pence" bigint NOT NULL,
"expense_account_code" text NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage_logs" ADD CONSTRAINT "mileage_logs_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_items" ADD CONSTRAINT "expense_claim_items_claim_id_expense_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."expense_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipts_entity_status_idx" ON "receipts" USING btree ("entity_id","status");--> statement-breakpoint
CREATE INDEX "receipts_entity_date_idx" ON "receipts" USING btree ("entity_id","receipt_date");--> statement-breakpoint
CREATE INDEX "receipts_matched_bank_idx" ON "receipts" USING btree ("matched_bank_tx_id");--> statement-breakpoint
CREATE INDEX "mileage_logs_entity_year_idx" ON "mileage_logs" USING btree ("entity_id","tax_year");--> statement-breakpoint
CREATE INDEX "mileage_logs_entity_date_idx" ON "mileage_logs" USING btree ("entity_id","journey_date");--> statement-breakpoint
CREATE INDEX "expense_claims_entity_status_idx" ON "expense_claims" USING btree ("entity_id","status");--> statement-breakpoint
CREATE INDEX "expense_claim_items_claim_idx" ON "expense_claim_items" USING btree ("claim_id");
