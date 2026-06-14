-- Add the composite-FK target FIRST, then drop the old single-column FK
-- and add the new composite FK.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_id_entity_uq" UNIQUE("id","entity_id");--> statement-breakpoint
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_entity_fk" FOREIGN KEY ("account_id","entity_id") REFERENCES "public"."accounts"("id","entity_id") ON DELETE restrict ON UPDATE no action;
