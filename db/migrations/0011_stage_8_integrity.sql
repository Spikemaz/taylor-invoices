-- Stage 8 follow-ups (integrity & security):
--   1. Add FK from year_end_checklists.period_id -> periods.id (set null on delete).
--   2. Add invite_expires_at to accountant_access (token expiry).
--   3. Add lookup index on accountant_access.invite_token_hash.

ALTER TABLE "year_end_checklists"
  ADD CONSTRAINT "year_end_checklists_period_id_periods_id_fk"
  FOREIGN KEY ("period_id") REFERENCES "periods"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "accountant_access"
  ADD COLUMN IF NOT EXISTS "invite_expires_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "accountant_access_token_hash_idx"
  ON "accountant_access" ("invite_token_hash");
