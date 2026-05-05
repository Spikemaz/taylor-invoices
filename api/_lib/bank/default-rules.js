/**
 * Stage 3 — UK default rule library.
 *
 * Seeded into every entity's `bank_rules` table at sign-up (or on first
 * Stage-3 sync). Each rule has:
 *   - priority: lower = checked first (10s = high-confidence brand
 *     matches, 100s = generic keyword fallbacks)
 *   - conditions: JSONB shape documented in `rules.js`
 *   - action: { kind: 'categorise', accountCode } or { kind: 'ignore' }
 *
 * The codes used here exist in BOTH UK_COA_SOLE_TRADER and UK_COA_LIMITED
 * (see api/_lib/ledger/accounts.js) so the same library works for both.
 *
 * NOTE: keyword matching is case-insensitive substring on the bank line's
 * description (and counterparty if present). We deliberately keep the
 * keywords short and brand-specific — anything ambiguous (e.g. "TESCO"
 * could be groceries OR a personal expense) is left to the user's own
 * rules / merchant memory.
 */

// Helper builders for readability.
const out = (accountCode) => ({ kind: 'categorise', accountCode });
const ignored = (reason) => ({ kind: 'ignore', reason });
const desc = (...kw) => ({
  anyOf: kw.map((value) => ({ field: 'description', op: 'contains_ci', value })),
});
const descOrCp = (...kw) => ({
  anyOf: kw.flatMap((value) => [
    { field: 'description', op: 'contains_ci', value },
    { field: 'counterparty', op: 'contains_ci', value },
  ]),
});

// =====================================================================
// The library
// =====================================================================
//
// Order is documentation-only — the priority field is what the engine
// uses, and within each band lower numbers match first.

const UK_DEFAULT_RULES = [
  // ------------------------------------------------------------------
  // 10–19  Travel — public transport (high confidence, brand keywords)
  // ------------------------------------------------------------------
  { name: 'TFL — Travel',                    priority: 10, conditions: { ...descOrCp('TFL', 'TRANSPORT FOR LONDON'), amountSign: 'out' }, action: out('7100') },
  { name: 'National Rail / Trainline',       priority: 11, conditions: { ...descOrCp('TRAINLINE', 'NATIONAL RAIL', 'LNER', 'GWR ', 'AVANTI'), amountSign: 'out' }, action: out('7100') },
  { name: 'Uber / Bolt / Lyft',              priority: 12, conditions: { ...descOrCp('UBER', 'BOLT.EU', 'LYFT'), amountSign: 'out' }, action: out('7100') },
  { name: 'Airlines',                        priority: 13, conditions: { ...descOrCp('BRITISH AIRWAYS', 'EASYJET', 'RYANAIR', 'JET2', 'WIZZAIR'), amountSign: 'out' }, action: out('7100') },
  { name: 'Hotels',                          priority: 14, conditions: { ...descOrCp('PREMIER INN', 'TRAVELODGE', 'BOOKING.COM', 'HILTON', 'MARRIOTT'), amountSign: 'out' }, action: out('7100') },

  // ------------------------------------------------------------------
  // 20–29  Subscriptions / SaaS (debit only)
  // ------------------------------------------------------------------
  { name: 'AWS',                             priority: 20, conditions: { ...descOrCp('AMAZON WEB SERVICES', 'AWS '), amountSign: 'out' }, action: out('7500') },
  { name: 'Google Workspace / Cloud',        priority: 21, conditions: { ...descOrCp('GOOGLE *WORKSPACE', 'GOOGLE WORKSPACE', 'GOOGLE CLOUD'), amountSign: 'out' }, action: out('7500') },
  { name: 'Microsoft 365 / Azure',           priority: 22, conditions: { ...descOrCp('MICROSOFT', 'MSFT'), amountSign: 'out' }, action: out('7500') },
  { name: 'GitHub',                          priority: 23, conditions: { ...descOrCp('GITHUB'), amountSign: 'out' }, action: out('7500') },
  { name: 'Notion',                          priority: 24, conditions: { ...descOrCp('NOTION LABS', 'NOTION.SO'), amountSign: 'out' }, action: out('7500') },
  { name: 'Dropbox',                         priority: 25, conditions: { ...descOrCp('DROPBOX'), amountSign: 'out' }, action: out('7500') },
  { name: 'Slack',                           priority: 26, conditions: { ...descOrCp('SLACK'), amountSign: 'out' }, action: out('7500') },
  { name: 'Adobe',                           priority: 27, conditions: { ...descOrCp('ADOBE'), amountSign: 'out' }, action: out('7500') },
  { name: 'Anthropic / OpenAI / LLM tools',  priority: 28, conditions: { ...descOrCp('ANTHROPIC', 'OPENAI', 'CLAUDE.AI'), amountSign: 'out' }, action: out('7500') },
  { name: 'Atlassian',                       priority: 29, conditions: { ...descOrCp('ATLASSIAN'), amountSign: 'out' }, action: out('7500') },

  // ------------------------------------------------------------------
  // 30–39  Telephone & Internet
  // ------------------------------------------------------------------
  { name: 'Mobile networks',                 priority: 30, conditions: { ...descOrCp('VODAFONE', 'EE LIMITED', 'O2 ', 'THREE MOBILE', 'GIFFGAFF'), amountSign: 'out' }, action: out('7400') },
  { name: 'Broadband / landline',            priority: 31, conditions: { ...descOrCp('BT GROUP', 'SKY DIGITAL', 'VIRGIN MEDIA', 'PLUSNET', 'TALKTALK'), amountSign: 'out' }, action: out('7400') },

  // ------------------------------------------------------------------
  // 40–49  Office costs (post, stationery, business rates)
  // ------------------------------------------------------------------
  { name: 'Royal Mail / Couriers',           priority: 40, conditions: { ...descOrCp('ROYAL MAIL', 'DPD', 'PARCELFORCE', 'HERMES', 'EVRI', 'FEDEX', 'UPS '), amountSign: 'out' }, action: out('7000') },
  { name: 'Stationery / supplies',           priority: 41, conditions: { ...descOrCp('VIKING DIRECT', 'OFFICE DEPOT', 'STAPLES'), amountSign: 'out' }, action: out('7000') },
  { name: 'Business rates / council',        priority: 42, conditions: { ...descOrCp('COUNCIL TAX', 'BUSINESS RATES', 'LB OF ', 'BOROUGH OF '), amountSign: 'out' }, action: out('7000') },
  { name: 'Utilities (energy, water)',       priority: 43, conditions: { ...descOrCp('BRITISH GAS', 'EDF ENERGY', 'OCTOPUS ENERGY', 'BULB ENERGY', 'THAMES WATER', 'SEVERN TRENT'), amountSign: 'out' }, action: out('7000') },

  // ------------------------------------------------------------------
  // 50–59  Motor expenses
  // ------------------------------------------------------------------
  { name: 'Fuel stations',                   priority: 50, conditions: { ...descOrCp('SHELL ', 'BP ', 'ESSO', 'TEXACO', 'SAINSBURYS PETROL', 'TESCO PETROL'), amountSign: 'out' }, action: out('7200') },
  { name: 'Vehicle services',                priority: 51, conditions: { ...descOrCp('KWIK FIT', 'HALFORDS', 'AUTOGLASS', 'NATIONAL TYRES'), amountSign: 'out' }, action: out('7200') },
  { name: 'Parking',                         priority: 52, conditions: { ...descOrCp('NCP CAR PARK', 'RINGGO', 'PAYBYPHONE PARKIN'), amountSign: 'out' }, action: out('7200') },
  { name: 'Congestion / ULEZ',               priority: 53, conditions: { ...descOrCp('CC AUTOPAY', 'ULEZ'), amountSign: 'out' }, action: out('7200') },

  // ------------------------------------------------------------------
  // 60–69  Bank / payment processor charges
  // ------------------------------------------------------------------
  { name: 'Stripe fees',                     priority: 60, conditions: { ...descOrCp('STRIPE PAYMENTS UK', 'STRIPE FEE'), amountSign: 'out' }, action: out('7700') },
  { name: 'GoCardless fees',                 priority: 61, conditions: { ...descOrCp('GOCARDLESS LTD'), amountSign: 'out' }, action: out('7700') },
  { name: 'Wise / FX fees',                  priority: 62, conditions: { ...descOrCp('WISE FEE', 'CURRENCYFAIR'), amountSign: 'out' }, action: out('7700') },
  { name: 'Bank charges generic',            priority: 63, conditions: { ...descOrCp('BANK CHARGE', 'OVERDRAFT FEE', 'NON-STERLING TRANSACTION FEE'), amountSign: 'out' }, action: out('7700') },

  // ------------------------------------------------------------------
  // 70–79  Professional fees
  // ------------------------------------------------------------------
  { name: 'Companies House',                 priority: 70, conditions: { ...descOrCp('COMPANIES HOUSE'), amountSign: 'out' }, action: out('7600') },
  { name: 'Accounting / legal',              priority: 71, conditions: { ...descOrCp('XERO ', 'FREEAGENT', 'QUICKBOOKS'), amountSign: 'out' }, action: out('7500') }, // bookkeeping subs
  { name: 'Insurance',                       priority: 72, conditions: { ...descOrCp('AVIVA', 'DIRECT LINE', 'HISCOX', 'ADMIRAL', 'SIMPLY BUSINESS'), amountSign: 'out' }, action: out('7800') },

  // ------------------------------------------------------------------
  // 80–89  Travel & subsistence (food on the road)
  // ------------------------------------------------------------------
  { name: 'Coffee chains',                   priority: 80, conditions: { ...descOrCp('COSTA COFFEE', 'STARBUCKS', 'CAFFE NERO', 'PRET A MANGER'), amountSign: 'out' }, action: out('7100') },

  // ------------------------------------------------------------------
  // 90–99  HMRC / statutory  (Ltd-only codes are skipped if missing —
  // the engine logs and falls through; sole traders just won't see
  // these triggered.)
  // ------------------------------------------------------------------
  { name: 'HMRC PAYE / NI',                  priority: 90, conditions: { ...descOrCp('HMRC NIC', 'HMRC PAYE'), amountSign: 'out' }, action: out('2210') },
  { name: 'HMRC VAT',                        priority: 91, conditions: { ...descOrCp('HMRC VAT'), amountSign: 'out' }, action: out('2200') },
  { name: 'HMRC Corporation Tax',            priority: 92, conditions: { ...descOrCp('HMRC CORP TAX', 'HMRC CT'), amountSign: 'out' }, action: out('2400') },
  { name: 'HMRC Self Assessment',            priority: 93, conditions: { ...descOrCp('HMRC SA', 'HMRC SELF ASSESSMENT'), amountSign: 'out' }, action: out('2300') }, // accruals

  // ------------------------------------------------------------------
  // 100+  Generic keyword fallbacks (lowest priority)
  // ------------------------------------------------------------------
  { name: 'Generic — "subscription"',        priority: 100, conditions: { ...desc('SUBSCRIPTION'), amountSign: 'out' }, action: out('7500') },
  { name: 'Generic — "office"',              priority: 101, conditions: { ...desc('OFFICE'), amountSign: 'out' }, action: out('7000') },
  { name: 'Generic — "insurance"',           priority: 102, conditions: { ...desc('INSURANCE'), amountSign: 'out' }, action: out('7800') },
  { name: 'Interest received',               priority: 103, conditions: { ...desc('INTEREST'), amountSign: 'in' }, action: out('4200') },
];

module.exports = { UK_DEFAULT_RULES };
