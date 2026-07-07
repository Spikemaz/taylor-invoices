# BooksIQ → Full Xero Clone Roadmap

Goal: turn BooksIQ into a complete digital accountant for self-employed and Ltd company users — bank feeds, automatic categorisation, year-round books, full UK tax engine (Self Assessment + Corporation Tax + payroll/dividends).

This is a 3–6 month build, broken into shippable stages. Each stage is independently useful.

---

## Stage 0 — Foundations (1 week)

Before building Xero features, harden what we already have so the new modules can plug in without churn.

- [ ] Move from "one Google Sheet per user" to a real database (Postgres on Vercel/Neon). Keep the sheet as an export-only mirror for users who want it.
- [ ] Define a stable internal schema: `accounts`, `transactions`, `invoices`, `entries`, `bank_accounts`, `bank_transactions`, `tax_rules`, `users`, `entities` (a user can have multiple — sole trader + Ltd).
- [ ] Add a server-side audit log for every mutation (who/what/when) — required for HMRC defensibility.
- [ ] Background job runner (Vercel Cron + a queue table) for nightly bank fetches, MTD submissions, etc.

## Stage 1 — Chart of Accounts + Double-Entry Ledger (1–2 weeks)

This is the spine. Everything else hangs off it.

- [ ] UK-standard Chart of Accounts (income, expenses, assets, liabilities, equity) — pre-seeded for self-employed and Ltd.
- [ ] Double-entry transaction engine: every transaction is two-sided (debit/credit). Invoices, expenses, bank movements all flow through it.
- [ ] Manual journal entries (for accountants).
- [ ] Trial Balance, P&L, Balance Sheet generated from the ledger.

## Stage 2 — Bank Feeds (2–4 weeks) ⭐ User priority

This is the "keeps your books up to date all year" feature.

**Open Banking (live feeds):**
- [ ] Integrate a UK Open Banking aggregator (TrueLayer, Plaid UK, or GoCardless Bank Account Data — the latter is **free** for AISP read-only and supports all major UK banks).
- [ ] OAuth flow: user links bank → we get 90 days of history + daily refreshes.
- [ ] Auto-sync nightly via cron.

**Manual statement upload (fallback for unsupported banks):**
- [ ] CSV import wizard with column mapping (handles Barclays, HSBC, Lloyds, Starling, Monzo, Revolut Business formats).
- [ ] PDF statement parsing (use `pdf-parse` + heuristics; or pay-per-page OCR via AWS Textract for scanned ones).
- [ ] Duplicate detection (hash of date+amount+description).

**Bank reconciliation UI:**
- [ ] Side-by-side: bank transactions (left) vs ledger entries (right).
- [ ] One-click "match" to existing invoice/expense.
- [ ] One-click "create + categorise" for unmatched lines.

## Stage 3 — Auto-Categorisation (2 weeks)

The magic that makes it feel like Xero.

- [ ] Rules engine: "if description contains X, categorise as Y" (per-user rules + global UK defaults — e.g. "TFL" → Travel).
- [ ] ML/LLM-assisted suggestions: when a new merchant appears, ask Claude to classify against the chart of accounts. Cache the answer per merchant per user.
- [ ] "Bank rules" UI for editing/training.

## Stage 4 — Expenses & Receipts (1 week)

- [ ] Receipt capture: phone camera → upload to existing Drive folder structure.
- [ ] OCR extract (vendor, date, total, VAT) using GPT-4o-mini or Textract.
- [ ] Match receipts to bank transactions automatically.
- [ ] Mileage log (HMRC AMAP rates: 45p/25p).

## Stage 5 — UK Tax Engine — Self-Employed (2–3 weeks)

Real-time Self Assessment.

- [ ] Live Self Assessment calculator using:
  - Personal allowance (£12,570, tapered above £100k)
  - Income tax bands (20/40/45)
  - Class 2 + Class 4 NI (current rates)
  - Trading allowance (£1,000)
  - Use-of-home, simplified expenses
- [ ] Per-tax-year P&L with adjustments (capital allowances, disallowables).
- [ ] Estimated tax bill always visible on the dashboard.
- [ ] Generate the SA103 (Self-Employment) figures ready for HMRC submission.

## Stage 6 — UK Tax Engine — Ltd Company (3–4 weeks)

The harder side — Corporation Tax + director's payroll + dividends.

- [ ] Corporation Tax: 19%/25% with marginal relief, ring-fenced from personal.
- [ ] Director's salary: PAYE thresholds (£12,570 / £9,100 NI secondary), generate payslips.
- [ ] Dividends: declare dividend, reduce retained earnings, track director loan account.
- [ ] Combined personal tax view: salary + dividends + dividend allowance (£500), dividend tax bands (8.75/33.75/39.35).
- [ ] CT600 figures ready to submit.
- [ ] Confirmation Statement reminder + Companies House filing fee tracking.

## Stage 7 — VAT (2 weeks, only if a user crosses £90k threshold)

- [ ] VAT registration tracking + threshold warnings.
- [ ] Standard / Flat Rate / Cash schemes.
- [ ] VAT return generation (boxes 1–9).
- [ ] **Making Tax Digital submission via HMRC API** — this is the regulatory requirement. We'd need to register as an MTD software vendor with HMRC (free, ~2 weeks process).

## Stage 8 — Year-End & Reports (1 week)

- [ ] Year-end checklist (close the books, lock period).
- [ ] Reports: P&L, Balance Sheet, Cash Flow, Aged Receivables, Aged Payables, VAT report, Director's Report.
- [ ] PDF export of all of the above.
- [ ] Accountant access: invite-an-accountant flow with read-only or full access.

## Stage 9 — Polish (ongoing)

- [ ] Multi-currency (for users invoicing internationally).
- [ ] Recurring invoices.
- [ ] Stripe / GoCardless payment links on invoices → auto-mark paid.
- [ ] Customer/supplier contacts module.
- [ ] Quotes → Invoices conversion.

---

## Suggested first sprint after the doubling fix lands

1. **Stage 0** (DB migration) — non-negotiable foundation.
2. **Stage 2 bank feeds with GoCardless Bank Account Data** — free, fastest visible value.
3. **Stage 1 ledger** in parallel — needed before bank feeds can be categorised properly.

Estimated to working "looks like Xero" MVP: ~6 weeks of focused work.

---

## Cost notes

- **GoCardless Bank Account Data**: free for AISP read access (covers all major UK banks).
- **TrueLayer / Plaid**: paid (~£0.10–0.30 per account per month).
- **HMRC MTD APIs**: free, but vendor registration required.
- **Postgres (Neon)**: free tier covers early users.
- **OCR**: GPT-4o-mini at ~$0.15 per 1k receipts is cheapest.

---

## Stage 10 — BooksIQ Edge (the moat; what Xero doesn't do)

Stage 9 brought us to Xero parity. Stage 10 is the moat: AI/predictive/proactive features that turn the ledger into a *digital accountant in your pocket*.

This is an umbrella menu — each bullet is its own multi-week build, tracked as a separate task.

### Beyond-Xero feature menu

- **AI accountant chat** — conversational tool-using LLM with read-only SQL over the user's ledger; answers "How much did I spend on travel last quarter?" with numbers + click-through to source.
- **Predictive cash-flow (90-day forecast)** — daily bank-balance projection from recurring invoices/expenses + seasonality; flags "you'll dip below zero on Aug 14".
- **Year-round tax-saving advisor** — milestone-driven prompts ("£3k SIPP would save £1,200 before April").
- **"What if I incorporated?" simulator** — sole-trader vs Ltd side-by-side using last 12 months.
- **IR35 status checker** — per-engagement CEST-equivalent flow.
- **Director's-loan-account guardian** — proactive s.455/BIK warnings.
- **Embedded smart payroll** — single-director PAYE in-app with RTI filing.
- **Pension tracker + relief calculator** — basic+higher rate relief gross-up.
- **Capital-allowances assistant** — AIA/FYA/WDA tracking by pool.
- **R&D tax-credit checker** — annual eligibility + evidence pack.
- **Bank-rule learning via embeddings** — semantic clustering replaces regex rules.
- **Multi-entity consolidation** — sole trader + Ltd combined dashboard.
- **HMRC-enquiry response assistant** — auto-bundles supporting docs.
- **White-label accountant multi-client portal**.
- **Voice-logged expenses** — voice → categorised journal.
- **Receipt vision matching** — confidence-scored bank-receipt linking.
- **Books health score** — gamified 0–100 dashboard widget.

### Top-3 prioritised for first follow-up tasks

1. AI accountant chat (highest "wow", highest stickiness).
2. Predictive cash-flow forecast (highest day-to-day utility).
3. Year-round tax-saving advisor (highest direct £ value to user).

The rest stay on the backlog and get spun out as the user prioritises them.
