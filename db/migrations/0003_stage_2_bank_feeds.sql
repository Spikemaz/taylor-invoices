CREATE TYPE "public"."bank_connection_provider" AS ENUM('csv', 'pdf', 'gocardless', 'truelayer', 'plaid', 'manual');--> statement-breakpoint
CREATE TYPE "public"."bank_connection_status" AS ENUM('active', 'disconnected', 'expired', 'error');--> statement-breakpoint
CREATE TYPE "public"."bank_tx_status" AS ENUM('unmatched', 'matched', 'posted', 'ignored');--> statement-breakpoint
CREATE TABLE "bank_connections" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"provider" "bank_connection_provider" NOT NULL,
"institution_id" text,
"institution_name" text,
"status" "bank_connection_status" DEFAULT 'active' NOT NULL,
"credentials_ciphertext" text,
"expires_at" timestamp with time zone,
"last_sync_at" timestamp with time zone,
"last_sync_error" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"connection_id" text,
"ledger_account_id" text NOT NULL,
"name" text NOT NULL,
"account_number_last4" text,
"sort_code" text,
"currency" text DEFAULT 'GBP' NOT NULL,
"opening_balance_pence" bigint DEFAULT 0 NOT NULL,
"opening_balance_date" date,
"archived" boolean DEFAULT false NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "bank_accounts_id_entity_uq" UNIQUE("id","entity_id")
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"bank_account_id" text NOT NULL,
"date" date NOT NULL,
"amount_pence" bigint NOT NULL,
"description" text NOT NULL,
"counterparty" text,
"reference" text,
"raw_payload" jsonb,
"dedupe_hash" text NOT NULL,
"status" "bank_tx_status" DEFAULT 'unmatched' NOT NULL,
"matched_journal_id" text,
"matched_at" timestamp with time zone,
"matched_by" text,
"ignored_reason" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "bank_transactions_amount_nonzero_chk" CHECK ("bank_transactions"."amount_pence" <> 0)
);
--> statement-breakpoint
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_ledger_account_fk" FOREIGN KEY ("ledger_account_id","entity_id") REFERENCES "public"."accounts"("id","entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_entity_fk" FOREIGN KEY ("bank_account_id","entity_id") REFERENCES "public"."bank_accounts"("id","entity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_connections_entity_idx" ON "bank_connections" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "bank_connections_status_idx" ON "bank_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bank_accounts_entity_idx" ON "bank_accounts" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "bank_accounts_connection_idx" ON "bank_accounts" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "bank_transactions_entity_date_idx" ON "bank_transactions" USING btree ("entity_id","date");--> statement-breakpoint
CREATE INDEX "bank_transactions_bank_account_date_idx" ON "bank_transactions" USING btree ("bank_account_id","date");--> statement-breakpoint
CREATE INDEX "bank_transactions_status_idx" ON "bank_transactions" USING btree ("bank_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_dedupe_uq" ON "bank_transactions" USING btree ("bank_account_id","dedupe_hash");
