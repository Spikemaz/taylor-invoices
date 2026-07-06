CREATE TYPE "public"."bank_rule_source" AS ENUM('system', 'user', 'learned');--> statement-breakpoint
CREATE TABLE "bank_rules" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"name" text NOT NULL,
"description" text,
"source" "bank_rule_source" DEFAULT 'user' NOT NULL,
"priority" integer DEFAULT 100 NOT NULL,
"conditions" jsonb NOT NULL,
"action" jsonb NOT NULL,
"active" boolean DEFAULT true NOT NULL,
"times_applied" integer DEFAULT 0 NOT NULL,
"last_applied_at" timestamp with time zone,
"created_by" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_memory" (
"id" text PRIMARY KEY NOT NULL,
"entity_id" text NOT NULL,
"merchant_signature" text NOT NULL,
"account_id" text NOT NULL,
"hits_count" integer DEFAULT 1 NOT NULL,
"confidence" integer DEFAULT 60 NOT NULL,
"last_used" timestamp with time zone DEFAULT now() NOT NULL,
"superseded_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_memory" ADD CONSTRAINT "merchant_memory_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_memory" ADD CONSTRAINT "merchant_memory_account_fk" FOREIGN KEY ("account_id","entity_id") REFERENCES "public"."accounts"("id","entity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_rules_entity_active_idx" ON "bank_rules" USING btree ("entity_id","active","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_memory_entity_sig_uq" ON "merchant_memory" USING btree ("entity_id","merchant_signature");
