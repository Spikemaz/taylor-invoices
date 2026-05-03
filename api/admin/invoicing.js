/**
 * /api/admin/invoicing — Stage 9 admin façade for the invoicing slice.
 *
 *   GET  ?kind=contacts&entityId=...&type=...
 *   GET  ?kind=invoices&entityId=...&contactId=...&status=...
 *   GET  ?kind=invoice&id=...
 *   GET  ?kind=quotes&entityId=...
 *   GET  ?kind=quote&id=...
 *   GET  ?kind=recurring&entityId=...
 *   GET  ?kind=payment_link&id=...
 *   GET  ?kind=statement&contactId=...&periodStart=...&periodEnd=...
 *   GET  ?kind=receivables_aging&entityId=...&asOfDate=...
 *   GET  ?kind=days_to_pay&entityId=...&lookbackDays=365
 *
 *   POST { kind:'contact_create', entityId, name, ... }
 *   POST { kind:'contact_update', id, ...patch }
 *   POST { kind:'contact_archive', id }
 *   POST { kind:'invoice_create', entityId, invoiceNumber, contactId?, totalPence, ... }
 *   POST { kind:'invoice_mark_paid', invoiceId, paidDate, amountPence, settleFxRateToBase? }
 *   POST { kind:'invoice_void', invoiceId, voidDate?, reason? }
 *   POST { kind:'quote_create', entityId, quoteNumber, totalPence, ... }
 *   POST { kind:'quote_accept', id }
 *   POST { kind:'quote_decline', id }
 *   POST { kind:'quote_convert', id, invoiceNumber, issueDate? }
 *   POST { kind:'recurring_create', entityId, contactId, frequency, startDate, totalPence, ... }
 *   POST { kind:'recurring_pause', id }
 *   POST { kind:'recurring_resume', id }
 *   POST { kind:'recurring_generate', entityId?, asOfDate }
 *   POST { kind:'payment_link_record', invoiceId, provider, providerRef, amountPence, currency? }
 *   POST { kind:'reminder_rule_create', entityId, name, trigger, daysOffset, templateSubject, templateBody }
 *   POST { kind:'reminders_compute', entityId, asOfDate }
 *
 * Admin-only, gated behind DB_BACKEND=postgres or DB_DUAL_WRITE=1.
 */

const { requireSession, applyCors } = require('../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../_lib/db');
const contactsLib = require('../_lib/contacts/contacts');
const invoicesLib = require('../_lib/invoicing/invoices');
const quotesLib = require('../_lib/invoicing/quotes');
const recurringLib = require('../_lib/invoicing/recurring');
const paymentLinksLib = require('../_lib/invoicing/payment-links');
const statementsLib = require('../_lib/invoicing/statements');
const remindersLib = require('../_lib/invoicing/reminders');
const dashboardLib = require('../_lib/invoicing/dashboard');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({ error: 'Stage 9 requires DB_BACKEND=postgres or DB_DUAL_WRITE=1' });
  }
  const actor = {
    userId: session.userId,
    email: session.email,
    role: session.role,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
  };
  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handlePost(req, res, actor);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[admin/invoicing] error:', err);
    return res.status(400).json({ error: String(err.message || err) });
  }
};

async function handleGet(req, res) {
  const q = req.query || {};
  const { kind } = q;
  switch (kind) {
    case 'contacts':
      return res.status(200).json({
        ok: true,
        contacts: await contactsLib.listContacts({
          entityId: q.entityId,
          type: q.type,
          includeArchived: q.includeArchived === '1',
        }),
      });
    case 'invoices':
      return res.status(200).json({
        ok: true,
        invoices: await invoicesLib.listInvoices({
          entityId: q.entityId,
          contactId: q.contactId,
          status: q.status,
        }),
      });
    case 'invoice':
      return res.status(200).json({ ok: true, invoice: await invoicesLib.getInvoice(q.id) });
    case 'quote':
      return res.status(200).json({ ok: true, quote: await quotesLib.getQuote(q.id) });
    case 'recurring':
      return res.status(200).json({
        ok: true,
        template: q.id ? await recurringLib.getTemplate(q.id) : null,
      });
    case 'payment_link':
      return res.status(200).json({ ok: true, paymentLink: await paymentLinksLib.getPaymentLink(q.id) });
    case 'statement':
      return res.status(200).json({
        ok: true,
        statement: await statementsLib.buildStatement({
          contactId: q.contactId,
          periodStart: q.periodStart,
          periodEnd: q.periodEnd,
        }),
      });
    case 'receivables_aging':
      return res.status(200).json({
        ok: true,
        aging: await dashboardLib.receivablesAging({
          entityId: q.entityId,
          asOfDate: q.asOfDate,
        }),
      });
    case 'days_to_pay':
      return res.status(200).json({
        ok: true,
        daysToPay: await dashboardLib.averageDaysToPay({
          entityId: q.entityId,
          lookbackDays: q.lookbackDays ? Number(q.lookbackDays) : 365,
        }),
      });
    default:
      return res.status(400).json({ error: `unknown kind: ${kind}` });
  }
}

async function handlePost(req, res, actor) {
  const body = req.body || {};
  const { kind } = body;
  switch (kind) {
    case 'contact_create':
      return res.status(200).json({ ok: true, ...(await contactsLib.createContact({ ...body, actor })) });
    case 'contact_update':
      await contactsLib.updateContact(body.id, { ...body, actor });
      return res.status(200).json({ ok: true });
    case 'contact_archive':
      await contactsLib.archiveContact(body.id, { actor });
      return res.status(200).json({ ok: true });

    case 'invoice_create':
      return res.status(200).json({ ok: true, ...(await invoicesLib.createInvoice({ ...body, actor })) });
    case 'invoice_mark_paid':
      return res.status(200).json({ ok: true, ...(await invoicesLib.markPaid({ ...body, actor })) });
    case 'invoice_void':
      return res.status(200).json({ ok: true, ...(await invoicesLib.voidInvoice({ ...body, actor })) });

    case 'quote_create':
      return res.status(200).json({ ok: true, ...(await quotesLib.createQuote({ ...body, actor })) });
    case 'quote_accept':
      return res.status(200).json({ ok: true, ...(await quotesLib.acceptQuote({ ...body, actor })) });
    case 'quote_decline':
      await quotesLib.declineQuote({ id: body.id, actor });
      return res.status(200).json({ ok: true });
    case 'quote_convert':
      return res.status(200).json({ ok: true, ...(await quotesLib.convertToInvoice({ ...body, actor })) });

    case 'recurring_create':
      return res.status(200).json({ ok: true, ...(await recurringLib.createTemplate({ ...body, actor })) });
    case 'recurring_pause':
      await recurringLib.pauseTemplate(body.id);
      return res.status(200).json({ ok: true });
    case 'recurring_resume':
      await recurringLib.resumeTemplate(body.id);
      return res.status(200).json({ ok: true });
    case 'recurring_generate':
      return res.status(200).json({
        ok: true,
        generated: await recurringLib.generateDueRecurring({
          entityId: body.entityId,
          asOfDate: body.asOfDate,
          actor,
        }),
      });

    case 'payment_link_record':
      return res
        .status(200)
        .json({ ok: true, ...(await paymentLinksLib.recordIntent({ ...body, actor })) });

    case 'reminder_rule_create':
      return res.status(200).json({ ok: true, ...(await remindersLib.createRule({ ...body, actor })) });
    case 'reminders_compute':
      return res.status(200).json({
        ok: true,
        inserted: await remindersLib.computeDueReminders({
          entityId: body.entityId,
          asOfDate: body.asOfDate,
          actor,
        }),
      });

    default:
      return res.status(400).json({ error: `unknown kind: ${kind}` });
  }
}
