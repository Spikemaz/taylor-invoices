CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'income', 'expense');--> statement-breakpoint
CREATE TYPE "public"."journal_source" AS ENUM('manual', 'invoice', 'invoice_payment', 'entry', 'expense', 'bank', 'reversal', 'opening_balance', 'backfill_v1');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"parent_id" text,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"journal_id" text NOT NULL,
	"account_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"date" date NOT NULL,
	"debit_pence" bigint DEFAULT 0 NOT NULL,
	"credit_pence" bigint DEFAULT 0 NOT NULL,
	"memo" text,
	"line_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_non_negative_chk" CHECK ("journal_lines"."debit_pence" >= 0 AND "journal_lines"."credit_pence" >= 0),
	CONSTRAINT "journal_lines_side_exclusive_chk" CHECK (NOT ("journal_lines"."debit_pence" > 0 AND "journal_lines"."credit_pence" > 0)),
	CONSTRAINT "journal_lines_non_zero_chk" CHECK ("journal_lines"."debit_pence" > 0 OR "journal_lines"."credit_pence" > 0)
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"source" "journal_source" NOT NULL,
	"source_type" text,
	"source_id" text,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"created_by" text,
	"reverses_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "periods" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"label" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "periods_range_chk" CHECK ("periods"."end_date" >= "periods"."start_date")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periods" ADD CONSTRAINT "periods_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_entity_code_uq" ON "accounts" USING btree ("entity_id","code");--> statement-breakpoint
CREATE INDEX "accounts_entity_type_idx" ON "accounts" USING btree ("entity_id","type");--> statement-breakpoint
CREATE INDEX "accounts_parent_idx" ON "accounts" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "journal_lines_journal_idx" ON "journal_lines" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_date_idx" ON "journal_lines" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "journal_lines_entity_date_idx" ON "journal_lines" USING btree ("entity_id","date");--> statement-breakpoint
CREATE INDEX "journals_entity_date_idx" ON "journals" USING btree ("entity_id","date");--> statement-breakpoint
CREATE INDEX "journals_source_idx" ON "journals" USING btree ("entity_id","source","source_id");--> statement-breakpoint
CREATE INDEX "journals_reverses_idx" ON "journals" USING btree ("reverses_id");--> statement-breakpoint
CREATE UNIQUE INDEX "periods_entity_range_uq" ON "periods" USING btree ("entity_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "periods_entity_end_idx" ON "periods" USING btree ("entity_id","end_date");--> statement-breakpoint
-- Stage 1 ledger invariant: SUM(debit) = SUM(credit) per journal.
--
-- Enforced via a CONSTRAINT TRIGGER that fires DEFERRED at COMMIT time.
-- Why deferred: the application inserts the journal header first, then
-- N lines in the same transaction. An IMMEDIATE trigger would fire after
-- the first INSERT and (correctly) reject every journal because it's
-- unbalanced mid-transaction. DEFERRED makes the check fire once, after
-- all the lines have landed but before the txn commits.
--
-- This is a defence-in-depth check on top of the application-side
-- validation in api/_lib/ledger/posting.js. Manual SQL (admin shells,
-- ETL fixes, panicked migrations) cannot create unbalanced journals.

CREATE OR REPLACE FUNCTION ledger_assert_journal_balanced()
RETURNS TRIGGER AS $$
DECLARE
        jid TEXT;
        total_debit BIGINT;
        total_credit BIGINT;
BEGIN
        -- The trigger fires per row; we coalesce TG_OP variants to find the
        -- journal_id we need to check (NEW for INSERT/UPDATE, OLD for DELETE).
        jid := COALESCE(NEW.journal_id, OLD.journal_id);
        IF jid IS NULL THEN
                RETURN NULL;
        END IF;

        SELECT
                COALESCE(SUM(debit_pence), 0),
                COALESCE(SUM(credit_pence), 0)
        INTO total_debit, total_credit
        FROM journal_lines
        WHERE journal_id = jid;

        -- Allow journals with zero lines to exist transiently within a
        -- transaction (e.g. caller deletes all lines before reposting).
        -- The application is responsible for the final shape; we only
        -- reject COMMITS where lines exist and don't balance.
        IF total_debit <> total_credit THEN
                RAISE EXCEPTION
                        'Journal % unbalanced: debit=% credit=% (must be equal)',
                        jid, total_debit, total_credit
                        USING ERRCODE = 'check_violation';
        END IF;

        RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced_trg
AFTER INSERT OR UPDATE OR DELETE ON journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ledger_assert_journal_balanced();
--> statement-breakpoint
-- Period-lock guard: reject any insert/update/delete on journal_lines
-- whose date falls inside a locked period. Defence-in-depth on top of
-- the application-side check in posting.js. Fires IMMEDIATELY (not
-- deferred) — locked-period violations should fail fast.

CREATE OR REPLACE FUNCTION ledger_assert_period_open()
RETURNS TRIGGER AS $$
DECLARE
        chk_date DATE;
        chk_entity TEXT;
        locked_count INT;
BEGIN
        chk_date := COALESCE(NEW.date, OLD.date);
        chk_entity := COALESCE(NEW.entity_id, OLD.entity_id);
        IF chk_date IS NULL OR chk_entity IS NULL THEN
                RETURN COALESCE(NEW, OLD);
        END IF;

        SELECT COUNT(*) INTO locked_count
        FROM periods
        WHERE entity_id = chk_entity
          AND locked_at IS NOT NULL
          AND chk_date BETWEEN start_date AND end_date;

        IF locked_count > 0 THEN
                RAISE EXCEPTION
                        'Cannot modify journal_line dated % — entity % has a locked period covering that date',
                        chk_date, chk_entity
                        USING ERRCODE = 'check_violation';
        END IF;

        RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_lines_period_lock_trg
BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION ledger_assert_period_open();
