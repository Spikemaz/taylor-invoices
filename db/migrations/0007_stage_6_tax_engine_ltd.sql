CREATE TYPE "public"."pay_frequency" AS ENUM('monthly', 'weekly', 'fortnightly', 'four_weekly');--> statement-breakpoint
CREATE TYPE "public"."payroll_run_status" AS ENUM('draft', 'posted', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."dividend_status" AS ENUM('declared', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."accounting_period_status" AS ENUM('open', 'locked');--> statement-breakpoint
CREATE TYPE "public"."companies_house_kind" AS ENUM('cs01', 'accounts', 'ct600');--> statement-breakpoint
CREATE TYPE "public"."companies_house_status" AS ENUM('upcoming', 'overdue', 'filed');--> statement-breakpoint
CREATE TABLE "payroll_employees" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"name" text NOT NULL,
"ni_number" text,
"tax_code" text DEFAULT '1257L' NOT NULL,
"pay_frequency" "pay_frequency" DEFAULT 'monthly' NOT NULL,
"annual_salary_pence" bigint DEFAULT 0 NOT NULL,
"is_director" boolean DEFAULT false NOT NULL,
"start_date" date NOT NULL,
"leave_date" date,
"archived" boolean DEFAULT false NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"employee_id" text NOT NULL,
"tax_year" integer NOT NULL,
"period_number" integer NOT NULL,
"pay_date" date NOT NULL,
"gross_pence" bigint NOT NULL,
"paye_pence" bigint DEFAULT 0 NOT NULL,
"ee_ni_pence" bigint DEFAULT 0 NOT NULL,
"er_ni_pence" bigint DEFAULT 0 NOT NULL,
"net_pence" bigint NOT NULL,
"ytd_gross_pence" bigint NOT NULL,
"ytd_paye_pence" bigint NOT NULL,
"ytd_ee_ni_pence" bigint NOT NULL,
"fps_payload" jsonb,
"status" "payroll_run_status" DEFAULT 'draft' NOT NULL,
"journal_id" text,
"notes" text,
"created_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dividends" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"declared_date" date NOT NULL,
"payment_date" date,
"voucher_number" text NOT NULL,
"shares_issued" integer DEFAULT 1 NOT NULL,
"per_share_amount_pence" bigint NOT NULL,
"total_amount_pence" bigint NOT NULL,
"status" "dividend_status" DEFAULT 'declared' NOT NULL,
"journal_id" text,
"notes" text,
"created_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_periods" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"start_date" date NOT NULL,
"end_date" date NOT NULL,
"status" "accounting_period_status" DEFAULT 'open' NOT NULL,
"ct_computed_pence" bigint,
"ct_computed_at" timestamp with time zone,
"notes" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies_house_filings" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"kind" "companies_house_kind" NOT NULL,
"due_date" date NOT NULL,
"status" "companies_house_status" DEFAULT 'upcoming' NOT NULL,
"fee_pence" bigint,
"completed_date" date,
"notes" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_employees" ADD CONSTRAINT "payroll_employees_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_employee_id_payroll_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."payroll_employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dividends" ADD CONSTRAINT "dividends_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies_house_filings" ADD CONSTRAINT "companies_house_filings_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_employees_entity_idx" ON "payroll_employees" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "payroll_runs_entity_year_idx" ON "payroll_runs" USING btree ("entity_id","tax_year");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_employee_period_uq" ON "payroll_runs" USING btree ("employee_id","tax_year","period_number");--> statement-breakpoint
CREATE INDEX "dividends_entity_date_idx" ON "dividends" USING btree ("entity_id","declared_date");--> statement-breakpoint
CREATE UNIQUE INDEX "dividends_entity_voucher_uq" ON "dividends" USING btree ("entity_id","voucher_number");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_periods_entity_range_uq" ON "accounting_periods" USING btree ("entity_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "companies_house_filings_entity_kind_idx" ON "companies_house_filings" USING btree ("entity_id","kind");--> statement-breakpoint
CREATE INDEX "companies_house_filings_entity_due_idx" ON "companies_house_filings" USING btree ("entity_id","due_date");
