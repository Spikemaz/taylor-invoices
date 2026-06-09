/**
 * Stage 2 — UK bank CSV statement parsers.
 *
 * Auto-detects the format from the header row of the uploaded CSV and
 * normalises every supported bank into the same `ParsedTransaction`
 * shape:
 *
 *   { date: 'YYYY-MM-DD', amountPence: <signed int>,
 *     description: string, counterparty?: string, reference?: string,
 *     rawRow: object }
 *
 * Supported out of the box: Starling, Monzo, Revolut Business, Barclays,
 * HSBC Personal, Lloyds. Anything else falls through to the GENERIC
 * detector which searches for the canonical column names; if that fails
 * the caller (admin endpoint) can supply an explicit column mapping.
 *
 * Amounts are returned as INTEGER PENCE, signed:
 *    +ve = money INTO the account (credit on the bank statement)
 *    -ve = money OUT of the account (debit on the bank statement)
 *
 * The caller decides how to translate that sign into a ledger journal:
 * a +ve amount on a 0800 bank account is `DR Bank / CR <income or
 * debtor>`, a -ve is `DR <expense or creditor> / CR Bank`.
 */

// =====================================================================
// Public API
// =====================================================================

const PARSERS = {
  starling: starlingParser(),
  monzo: monzoParser(),
  revolut_business: revolutBusinessParser(),
  barclays: barclaysParser(),
  hsbc: hsbcParser(),
  lloyds: lloydsParser(),
  generic: genericParser(),
};

/**
 * Detect the bank format from the header row of a CSV. Returns the
 * parser key (e.g. 'starling') or 'generic' as a last resort. Returns
 * null only if the file is not a valid CSV at all.
 */
function detectFormat(csvText) {
  const firstLine = (csvText || '').split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  const headers = parseCsvLine(firstLine).map((h) => normaliseHeader(h));
  for (const [key, p] of Object.entries(PARSERS)) {
    if (key === 'generic') continue;
    if (p.matches(headers)) return key;
  }
  // Fall back to generic if at least one of (date, amount, description) is present.
  return PARSERS.generic.matches(headers) ? 'generic' : null;
}

/**
 * Parse a CSV string into normalised rows. Throws on unrecoverable parse
 * errors (e.g. file isn't a CSV). Skips blank lines and rows the parser
 * declares invalid (e.g. missing date) and reports them via `skipped`.
 *
 * @param {string} csvText
 * @param {object} [opts]
 * @param {string} [opts.format]   force a parser (one of the keys in PARSERS)
 * @param {object} [opts.mapping]  for 'generic': { date, amount, description, ... }
 * @returns {{ format: string, rows: ParsedTransaction[], skipped: Array<{lineNo, reason, raw}> }}
 */
function parseStatementCsv(csvText, opts = {}) {
  const text = String(csvText || '');
  let format = opts.format;
  if (!format) {
    format = detectFormat(text);
    if (!format) {
      throw new Error('CSV format could not be detected — no recognisable date/amount/description headers');
    }
  }
  const parser = PARSERS[format];
  if (!parser) throw new Error(`Unknown parser: ${format}`);

  const lines = text.split(/\r?\n/);
  const rows = [];
  const skipped = [];
  let headerCols = null;
  let lineNo = 0;
  for (const raw of lines) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;
    const cols = parseCsvLine(raw);
    if (!headerCols) {
      headerCols = cols.map(normaliseHeader);
      continue;
    }
    try {
      const row = parser.parseRow(headerCols, cols, opts);
      if (!row) {
        skipped.push({ lineNo, reason: 'parser returned null', raw });
        continue;
      }
      rows.push(row);
    } catch (err) {
      skipped.push({ lineNo, reason: err.message, raw });
    }
  }
  return { format, rows, skipped };
}

// =====================================================================
// Per-bank parsers
// =====================================================================

function starlingParser() {
  return {
    matches(headers) {
      const has = (h) => headers.includes(h);
      return has('counter party') && has('amount (gbp)') && has('reference');
    },
    parseRow(headers, cols) {
      const date = parseDate(get(headers, cols, 'date'));
      const amountPence = parseAmountPence(get(headers, cols, 'amount (gbp)'));
      const counterparty = get(headers, cols, 'counter party') || '';
      const reference = get(headers, cols, 'reference') || '';
      const type = get(headers, cols, 'type') || '';
      const description = [counterparty, reference, type].filter(Boolean).join(' — ') || 'Starling transaction';
      return wrap({ date, amountPence, description, counterparty, reference, rawRow: zip(headers, cols) });
    },
  };
}

function monzoParser() {
  return {
    matches(headers) {
      return headers.includes('transaction id') && headers.includes('amount') && headers.includes('name');
    },
    parseRow(headers, cols) {
      const date = parseDate(get(headers, cols, 'date'));
      const amountPence = parseAmountPence(get(headers, cols, 'amount'));
      const counterparty = get(headers, cols, 'name') || '';
      const description = get(headers, cols, 'description') || counterparty || 'Monzo transaction';
      const reference = get(headers, cols, 'transaction id') || '';
      return wrap({ date, amountPence, description, counterparty, reference, rawRow: zip(headers, cols) });
    },
  };
}

function revolutBusinessParser() {
  return {
    matches(headers) {
      return (
        headers.includes('date completed') &&
        headers.includes('amount') &&
        (headers.includes('description') || headers.includes('reference'))
      );
    },
    parseRow(headers, cols) {
      // Prefer "Date completed"; fall back to "Date started" for pending tx.
      const dateRaw =
        get(headers, cols, 'date completed') ||
        get(headers, cols, 'date started') ||
        get(headers, cols, 'date');
      const date = parseDate(dateRaw);
      const amountPence = parseAmountPence(get(headers, cols, 'amount'));
      const description = get(headers, cols, 'description') || get(headers, cols, 'type') || 'Revolut transaction';
      const reference = get(headers, cols, 'reference') || get(headers, cols, 'id') || '';
      const counterparty = get(headers, cols, 'payer') || get(headers, cols, 'beneficiary') || '';
      return wrap({ date, amountPence, description, counterparty, reference, rawRow: zip(headers, cols) });
    },
  };
}

function barclaysParser() {
  return {
    matches(headers) {
      return (
        headers.includes('memo') &&
        headers.includes('amount') &&
        (headers.includes('subcategory') || headers.includes('account'))
      );
    },
    parseRow(headers, cols) {
      const date = parseDate(get(headers, cols, 'date'));
      const amountPence = parseAmountPence(get(headers, cols, 'amount'));
      const description = get(headers, cols, 'memo') || 'Barclays transaction';
      const reference = get(headers, cols, 'number') || '';
      return wrap({ date, amountPence, description, reference, rawRow: zip(headers, cols) });
    },
  };
}

function hsbcParser() {
  return {
    matches(headers) {
      return (
        headers.length === 4 &&
        headers.includes('date') &&
        headers.includes('description') &&
        headers.includes('amount') &&
        headers.includes('balance')
      );
    },
    parseRow(headers, cols) {
      const date = parseDate(get(headers, cols, 'date'));
      const amountPence = parseAmountPence(get(headers, cols, 'amount'));
      const description = get(headers, cols, 'description') || 'HSBC transaction';
      return wrap({ date, amountPence, description, rawRow: zip(headers, cols) });
    },
  };
}

function lloydsParser() {
  return {
    matches(headers) {
      return (
        headers.includes('transaction date') &&
        headers.includes('debit amount') &&
        headers.includes('credit amount')
      );
    },
    parseRow(headers, cols) {
      const date = parseDate(get(headers, cols, 'transaction date'));
      const debit = parseAmountPence(get(headers, cols, 'debit amount'), { allowEmpty: true });
      const credit = parseAmountPence(get(headers, cols, 'credit amount'), { allowEmpty: true });
      const amountPence = (credit || 0) - (debit || 0);
      const description =
        get(headers, cols, 'transaction description') ||
        get(headers, cols, 'transaction type') ||
        'Lloyds transaction';
      return wrap({ date, amountPence, description, rawRow: zip(headers, cols) });
    },
  };
}

function genericParser() {
  // Looks for any column whose normalised name matches our canonical
  // names. Caller can override via opts.mapping = { date, amount,
  // debit, credit, description, reference, counterparty }.
  return {
    matches(headers) {
      const dateCol = headers.some((h) => /\bdate\b/.test(h));
      const amtCol = headers.some((h) => /\bamount\b/.test(h) || /\bdebit\b/.test(h) || /\bcredit\b/.test(h));
      const descCol = headers.some((h) => /\b(description|memo|narrative|details|type)\b/.test(h));
      return dateCol && amtCol && descCol;
    },
    parseRow(headers, cols, opts = {}) {
      const map = opts.mapping || {};
      const dateRaw = pick(headers, cols, map.date, ['date', 'transaction date', 'date completed']);
      const date = parseDate(dateRaw);
      let amountPence;
      if (map.debit || map.credit) {
        const debit = parseAmountPence(pick(headers, cols, map.debit, ['debit', 'debit amount']), { allowEmpty: true });
        const credit = parseAmountPence(pick(headers, cols, map.credit, ['credit', 'credit amount']), { allowEmpty: true });
        amountPence = (credit || 0) - (debit || 0);
      } else {
        amountPence = parseAmountPence(pick(headers, cols, map.amount, ['amount', 'amount (gbp)', 'value']));
      }
      const description = pick(headers, cols, map.description, ['description', 'memo', 'narrative', 'details', 'type', 'reference']) || 'Bank transaction';
      const reference = pick(headers, cols, map.reference, ['reference']);
      const counterparty = pick(headers, cols, map.counterparty, ['counter party', 'counterparty', 'name', 'payee', 'payer']);
      return wrap({ date, amountPence, description, counterparty, reference, rawRow: zip(headers, cols) });
    },
  };
}

// =====================================================================
// Helpers
// =====================================================================

function normaliseHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/^\ufeff/, '');
}

/** Get the value for a given normalised header name from a row's columns. */
function get(headers, cols, name) {
  const i = headers.indexOf(name);
  if (i === -1) return '';
  return (cols[i] || '').trim();
}

/** Pick the first non-empty value for either a forced column or a list of fallbacks. */
function pick(headers, cols, forced, fallbacks) {
  if (forced) {
    const v = get(headers, cols, normaliseHeader(forced));
    if (v) return v;
  }
  for (const name of fallbacks || []) {
    const v = get(headers, cols, name);
    if (v) return v;
  }
  return '';
}

function zip(headers, cols) {
  const out = {};
  for (let i = 0; i < headers.length; i++) {
    out[headers[i]] = cols[i] === undefined ? null : cols[i];
  }
  return out;
}

function wrap(row) {
  if (!row.date) throw new Error('missing date');
  if (!Number.isInteger(row.amountPence) || row.amountPence === 0) {
    throw new Error('zero or non-numeric amount');
  }
  if (!row.description) row.description = 'Bank transaction';
  return row;
}

/**
 * Parse a date in any of: ISO (YYYY-MM-DD), DD/MM/YYYY, D/M/YY,
 * "DD MMM YYYY". Returns YYYY-MM-DD or throws.
 */
function parseDate(s) {
  const v = String(s || '').trim();
  if (!v) throw new Error('missing date');
  // ISO YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // DD/MM/YYYY or D/M/YY (UK convention — banks always render UK CSVs this way)
  const uk = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (uk) {
    let [, d, m, y] = uk;
    if (y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // "01 Apr 2025"
  const named = v.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2,4})$/);
  if (named) {
    const [, d, mn, y] = named;
    const mi = MONTH_NAMES.indexOf(mn.slice(0, 3).toLowerCase());
    if (mi >= 0) {
      const yy = y.length === 2 ? (Number(y) > 50 ? '19' : '20') + y : y;
      return `${yy}-${String(mi + 1).padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }
  throw new Error(`unrecognised date format: ${v}`);
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parse a money string into integer pence. Handles "12.34", "-12.34",
 * "(12.34)" (accountancy negatives), "£12.34", "1,234.56".
 *
 * Returns null when the cell is empty (used by Lloyds-style two-column
 * debit/credit splits where one of the two is always blank).
 */
function parseAmountPence(s, opts = {}) {
  let v = String(s == null ? '' : s).trim();
  if (!v) {
    if (opts.allowEmpty) return null;
    throw new Error('missing amount');
  }
  // Accountancy parens negative.
  let sign = 1;
  if (/^\(.*\)$/.test(v)) {
    sign = -1;
    v = v.slice(1, -1);
  }
  // Strip currency symbols, thousands separators, and stray whitespace.
  v = v.replace(/[£$€,\s]/g, '');
  if (v.startsWith('+')) v = v.slice(1);
  if (v.startsWith('-')) {
    sign = sign * -1;
    v = v.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(v)) {
    throw new Error(`unrecognised amount: ${s}`);
  }
  // Round-half-away-from-zero — see poundsToPence in the ledger lib.
  const pence = Math.round(parseFloat(parseFloat(v).toFixed(4)) * 100);
  return sign * pence;
}

/**
 * Parse a single CSV line. Supports double-quoted values with embedded
 * commas and escaped quotes ("" → "). Sufficient for the formats above.
 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

module.exports = {
  detectFormat,
  parseStatementCsv,
  // Exposed for unit tests / smoke
  _internal: { parseDate, parseAmountPence, parseCsvLine, normaliseHeader, PARSERS },
};
