CREATE TYPE "public"."tax_year_status" AS ENUM('open', 'locked');--> statement-breakpoint
CREATE TYPE "public"."capital_allowance_pool" AS ENUM('aia', 'main', 'special', 'sba');--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "tax_treatment" text;--> statement-breakpoint
CREATE TABLE "tax_rules" (
"tax_year" integer NOT NULL,
"region" text NOT NULL,
"rule_set" jsonb NOT NULL,
"notes" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "tax_rules_pk" PRIMARY KEY("tax_year","region")
);
--> statement-breakpoint
CREATE TABLE "tax_years" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"tax_year" integer NOT NULL,
"region" text DEFAULT 'rUK' NOT NULL,
"status" "tax_year_status" DEFAULT 'open' NOT NULL,
"locked_at" timestamp with time zone,
"locked_by" text,
"notes" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_allowance_assets" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"tax_year" integer NOT NULL,
"pool_type" "capital_allowance_pool" NOT NULL,
"description" text NOT NULL,
"acquired_date" date NOT NULL,
"cost_pence" bigint NOT NULL,
"claim_aia" boolean DEFAULT true NOT NULL,
"disposed_date" date,
"disposal_proceeds_pence" bigint,
"notes" text,
"created_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_allowance_pools" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"tax_year" integer NOT NULL,
"pool_type" "capital_allowance_pool" NOT NULL,
"opening_wdv_pence" bigint DEFAULT 0 NOT NULL,
"additions_pence" bigint DEFAULT 0 NOT NULL,
"disposals_pence" bigint DEFAULT 0 NOT NULL,
"aia_claimed_pence" bigint DEFAULT 0 NOT NULL,
"wda_claimed_pence" bigint DEFAULT 0 NOT NULL,
"closing_wdv_pence" bigint DEFAULT 0 NOT NULL,
"computed_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tax_years" ADD CONSTRAINT "tax_years_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_allowance_assets" ADD CONSTRAINT "capital_allowance_assets_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_allowance_pools" ADD CONSTRAINT "capital_allowance_pools_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_years_entity_year_uq" ON "tax_years" USING btree ("entity_id","tax_year");--> statement-breakpoint
CREATE INDEX "capital_allowance_assets_entity_year_idx" ON "capital_allowance_assets" USING btree ("entity_id","tax_year");--> statement-breakpoint
CREATE INDEX "capital_allowance_assets_entity_pool_idx" ON "capital_allowance_assets" USING btree ("entity_id","pool_type");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_allowance_pools_entity_year_pool_uq" ON "capital_allowance_pools" USING btree ("entity_id","tax_year","pool_type");
