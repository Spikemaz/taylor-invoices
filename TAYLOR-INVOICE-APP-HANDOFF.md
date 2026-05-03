# Taylor Muir Invoice Manager — Claude Code Handoff Documentation

## Project Overview

Mobile-first PWA for dental hygienist Taylor Muir to log daily patient work, auto-calculate commission, generate professional PDF invoices, and sync everything to Google Sheets and Google Drive. Built as a single-file HTML app (~149KB) with vanilla JS, currently using localStorage. This document covers everything needed to make it production-ready.

---

## What Already Works (DO NOT REBUILD)

The frontend HTML app (`taylor-invoice-manager.html`) is fully functional and tested. It includes:

- Smart auto-open based on day of week (Mon/Fri → Bupa, Thu → Grove, else → Home)
- Midnight reset timer to re-route at 23:59 each night
- Entity switching (Self-Employed ↔ Ltd Company) with filtered metrics per entity
- Practice logging with service selection, patient count steppers, airflow add-ons
- Duplicate detection based on date + practice + service + price (allows same service at different prices)
- Archive with swipe-to-delete, colour-coded day borders, day names on entries
- Invoice preview and generation (currently canvas-to-PNG — needs replacing with proper PDF)
- Settings screen with full editing for all fields (entity details, practice config, days, bank, payment terms)
- Add contracted practice from Home (with import from ad hoc list)
- Ad hoc practice management
- Running totals (weekly + monthly net revenue) filtered by active entity
- Two logos embedded as base64 (self-employed blue tooth logo, Ltd green H&T logo)

---

## What Needs Building

### 1. Vercel Deployment (New Project)

**Setup:**
- Create new Vercel project (not connected to Atlas Nexus)
- Default `.vercel.app` URL is fine (no custom domain needed)
- No authentication required (Taylor's iPhone has device-level protection)
- Always-online — no offline/PWA caching needed

**Architecture:**
```
taylor-invoices/
├── public/
│   └── index.html          ← The existing single-file app
├── api/
│   ├── generate-pdf.js     ← Serverless function for PDF generation
│   ├── sheets-sync.js      ← Serverless function for Google Sheets read/write
│   └── drive-upload.js     ← Serverless function for Google Drive PDF upload
├── package.json
├── vercel.json
└── .env                    ← Google API credentials (Vercel env vars)
```

**vercel.json:**
```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

### 2. Google Cloud Setup

**Account:** taylormuir1993@gmail.com (personal Google account, nothing configured yet, logged in and ready)

**Steps required:**
1. Go to Google Cloud Console → Create new project "Taylor Invoices"
2. Enable these APIs:
   - Google Sheets API
   - Google Drive API
3. Create OAuth 2.0 credentials (Web application type)
   - Add Vercel URL as authorized redirect URI
4. OR create a Service Account (simpler for single-user):
   - Download JSON key file
   - Share the target Google Sheet with the service account email
   - Share the target Google Drive folder with the service account email
   - Store credentials as Vercel environment variables

**Recommendation:** Use a Service Account — it's simpler since there's only one user and no login flow needed. The service account email gets shared on the specific Sheet and Drive folder.

**Environment variables needed on Vercel:**
```
GOOGLE_SERVICE_ACCOUNT_EMAIL=taylor-invoices@taylor-invoices-xxxxx.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...
GOOGLE_SHEET_ID=<spreadsheet ID after creation>
GOOGLE_DRIVE_FOLDER_ID=<root folder ID>
```

### 3. Google Sheets — Data Model

**Create one Google Sheet** called "Taylor Invoice Manager" with these tabs:

#### Tab 1: "Entries" (Daily work log)
| Column | Header | Description |
|--------|--------|-------------|
| A | Entry ID | Unique ID (e.g. L1707654321000) |
| B | Date | YYYY-MM-DD |
| C | Day | Mon/Tue/Wed/Thu/Fri/Sat/Sun |
| D | Entity | Self-Employed / Ltd |
| E | Practice ID | bupa / grove / p1707654321000 etc |
| F | Practice Name | Bupa / The Grove / etc |
| G | Type | contract / adhoc |
| H | Service | Private / Denplan / Hygiene / Perio etc |
| I | Patients | Number |
| J | Unit Price | £ per patient |
| K | Airflow Patients | Number (ad hoc only) |
| L | Airflow Amount | £ total airflow add-on |
| M | Gross Revenue | £ total (patients × price + airflow) |
| N | Commission % | 35% / 40% / 0% for ad hoc |
| O | Commission Amount | £ |
| P | Invoice Status | pending / invoiced |
| Q | Invoice Number | 00001 etc (blank if pending) |
| R | Timestamp | ISO datetime when logged |

**Formatting:** Header row frozen, bold, with light grey background. Date column formatted as dates. Currency columns formatted as £0.00. Auto-filter enabled.

#### Tab 2: "Invoices" (Generated invoice log)
| Column | Header | Description |
|--------|--------|-------------|
| A | Invoice Number | 00001, 00002 etc |
| B | Date Generated | YYYY-MM-DD |
| C | Entity | Self-Employed / Ltd |
| D | Practice | Bupa / The Grove / etc |
| E | Period | February 2026 / or specific date for ad hoc |
| F | Type | Monthly Commission / Ad Hoc |
| G | Gross Revenue | £ total before commission |
| H | Commission Rate | 35% / 40% / N/A |
| I | Net Amount (Balance Due) | £ amount on invoice |
| J | PDF Link | Google Drive hyperlink to the PDF file |
| K | Status | Generated / Paid / Overdue |
| L | Payment Date | Date paid (blank until paid) |
| M | Notes | Optional notes |

**Formatting:** Header row frozen, bold. Currency formatted. Invoice Number column as text (to preserve leading zeros). PDF Link column should contain clickable hyperlinks.

#### Tab 3: "Practices" (Practice configuration backup)
| Column | Header | Description |
|--------|--------|-------------|
| A | Practice ID | bupa / grove / custom IDs |
| B | Name | Full practice name |
| C | Short Name | Display name |
| D | Address | Full address |
| E | Type | contract / adhoc |
| F | Commission % | 35 / 40 / 0 |
| G | Days | 1,5 / 4 / etc |
| H | Services | JSON string of services config |
| I | Active | TRUE/FALSE |

#### Tab 4: "Settings" (App configuration backup)
| Column | Header | Description |
|--------|--------|-------------|
| A | Key | Setting name |
| B | Value | Setting value |

Rows: nextInvoiceNumber, activeEntity, paymentTerms, selfEmployedName, selfEmployedAddress, selfEmployedPhone, selfEmployedBank, selfEmployedAccName, selfEmployedAcc, selfEmployedSort, ltdName, ltdAddress, ltdPhone, ltdBank, ltdAccName, ltdAcc, ltdSort, ltdCompanyNumber

#### Tab 5: "Dashboard" (Summary view)
Auto-calculated summary using SUMIFS formulas:
- Current month gross revenue by practice
- Current month commission by practice  
- Year-to-date totals
- This week vs last week comparison
- Count of pending vs invoiced entries

### 4. Google Sheets API Integration

**Endpoint: `/api/sheets-sync.js`**

This serverless function handles all Sheet operations:

```
POST /api/sheets-sync
Body: { action: "append_entry", data: { ...entry } }
Body: { action: "append_invoice", data: { ...invoice } }
Body: { action: "update_entry", data: { id, updates } }
Body: { action: "delete_entry", data: { id } }
Body: { action: "sync_practices", data: { practices } }
Body: { action: "sync_settings", data: { settings } }
Body: { action: "load_all" }  ← Returns all data for initial load
Body: { action: "update_invoice_status", data: { invoiceNum, status, paymentDate } }
```

**Implementation notes:**
- Use `googleapis` npm package (google-auth-library + googleapis)
- Service account authentication
- Append entries to bottom of Entries tab
- For updates, find row by Entry ID in column A, then update
- For deletes, find row by Entry ID, delete entire row (shift up)
- `load_all` returns all tabs' data as JSON for the app to hydrate from
- Include error handling and retry logic
- Return Google Sheets row number for reference

**Frontend integration — modify the app's `save()` function:**
```javascript
// After localStorage save, also POST to API
fetch('/api/sheets-sync', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({action: 'append_entry', data: entry})
}).then(r => r.json()).then(result => {
  showToast('✓ Saved to Sheet');
}).catch(err => {
  showToast('⚠ Sheet save failed — data saved locally', 'warn');
});
```

**Frontend integration — modify `load()` on app startup:**
```javascript
// On DOMContentLoaded, try to load from Sheets first
fetch('/api/sheets-sync', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({action: 'load_all'})
}).then(r => r.json()).then(data => {
  // Merge with localStorage, preferring Sheet data
  S.entries = data.entries || S.entries;
  S.invoices = data.invoices || S.invoices;
  // ... etc
}).catch(err => {
  // Fall back to localStorage silently
});
```

### 5. Google Drive — PDF Storage

**Folder structure to create automatically:**
```
Taylor Invoices/                          ← Root folder (ID stored in env var)
├── Self-Employed/
│   └── 2026/
│       ├── January/
│       ├── February/
│       └── ... (created on-demand)
└── Ltd Company/
    └── 2026/
        ├── January/
        ├── February/
        └── ... (created on-demand)
```

**Endpoint: `/api/drive-upload.js`**

```
POST /api/drive-upload
Body: { 
  pdfBuffer: <base64 encoded PDF>,
  fileName: "Invoice-00001.pdf",
  entity: "self" | "ltd",
  year: "2026",
  month: "February"
}
Response: { fileId, webViewLink, webContentLink }
```

**Implementation:**
- Use `googleapis` Drive v3 API
- On upload: check if entity folder exists → create if not → check year folder → create if not → check month folder → create if not → upload PDF
- Return the Google Drive file link
- Store that link in the Invoices tab column J

**Auto-create folder logic:**
```javascript
async function getOrCreateFolder(parentId, folderName) {
  // Search for existing folder
  const query = `'${parentId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q: query, fields: 'files(id)' });
  if (res.data.files.length > 0) return res.data.files[0].id;
  // Create folder
  const folder = await drive.files.create({
    resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id'
  });
  return folder.data.id;
}
```

### 6. PDF Generation (Server-side)

**Endpoint: `/api/generate-pdf.js`**

Replace the current client-side canvas approach with server-side jsPDF on Vercel.

**Package:** `jspdf` (npm install jspdf)

**The PDF must match this layout** (based on Taylor's original Invoice-00001.pdf):

```
┌──────────────────────────────────────────────────────────┐
│  [LOGO]                                                  │
│                                      Taylor Muir         │
│                              (or Ltd company name)       │
│                                  9 Queen Cathrine Road   │
│                                  Steeple Claydon         │  
│                                  Buckingham              │
│                                  MK18 2PZ                │
│                                  +44 7429 399687         │
│                                                          │
│                                              Invoice     │
│                                                          │
│  Bill To:   Bupa Dental Care       Invoice Number  00001 │
│             39 Buckingham Road        Invoice Date  11/02/2026 │
│             Aylesbury                                    │
│             Buckinghamshire                              │
│             HP19 9PT                                     │
│                                                          │
│  ──────────────────────────────────────────────────────  │
│  Item          Description       Unit Price  Qty  Subtotal│
│  ──────────────────────────────────────────────────────  │
│  Private       £93.00 per        93.00       8    744.00 │
│  Hygiene       patient hygiene                           │
│                                                          │
│  Denplan       £93.00 per        93.00       4    372.00 │
│  Hygiene       patient hygiene                           │
│                                                          │
│  Airflow       Airflow add-on                     18.00  │
│  Add-on                                                  │
│  ──────────────────────────────────────────────────────  │
│                                  Total         £1,134.00 │
│                                  Commission @35%         │
│                                  Balance Due    £396.90  │
│                                                          │
│  ──────────────────────────────────────────────────────  │
│  Name: Miss Taylor Muir                                  │
│  Account: 45191768                                       │
│  Sort Code: 77-21-08                                     │
│                                                          │
│  Payment Terms: Payment is due within 5 working days     │
│  of the invoice date.                                    │
│  Please ensure the invoice reference is quoted with      │
│  payment.                                                │
│  Thank you for your continued support.                   │
│                                                          │
│  ──────────────────────────────────────────────────────  │
│  (For Ltd: Company No: XXXXXXXX)                         │
└──────────────────────────────────────────────────────────┘
```

**Entity-specific differences:**

| Field | Self-Employed | Ltd Company |
|-------|--------------|-------------|
| Logo | Blue tooth/brush logo (base64 in app as `LOGO.self`) | Green H&T logo (base64 in app as `LOGO.ltd`) |
| Name | Taylor Muir | Hygiene and Therapy Clinical Services Ltd |
| Address | 9 Queen Cathrine Road, Steeple Claydon, Buckingham, MK18 2PZ | 71-75 Shelton Street, Covent Garden, London, WC2H 9JQ |
| Bank name | Miss Taylor Muir | Miss Taylor Muir (same for now, editable in settings) |
| Company Number | Not shown | Show "Company No: XXXXXXXX" at bottom |
| Commission line | Shows "Commission @35%" or @40% | Same |

**For ad hoc invoices:**
- No commission line
- Balance Due = Gross Total
- "Item" column shows service type
- Description shows "£X per patient" rate

**Implementation approach:**
```javascript
// api/generate-pdf.js
const { jsPDF } = require('jspdf');

module.exports = async (req, res) => {
  const inv = req.body;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  
  // Add logo from base64
  doc.addImage(inv.logoBase64, 'JPEG', 15, 15, 25, 25);
  
  // Build invoice matching the layout above
  // ... (full implementation)
  
  const pdfBuffer = doc.output('arraybuffer');
  
  // Upload to Google Drive
  const driveResult = await uploadToDrive(pdfBuffer, inv);
  
  // Update Google Sheet with Drive link
  await updateSheetWithLink(inv.num, driveResult.webViewLink);
  
  // Return PDF as download + Drive link
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=Invoice-${inv.num}.pdf`);
  res.send(Buffer.from(pdfBuffer));
};
```

**Frontend change — replace `generatePDF()` function:**
```javascript
function generatePDF(inv) {
  showToast('Generating PDF...');
  fetch('/api/generate-pdf', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(inv)
  }).then(response => {
    // Download the PDF
    return response.blob();
  }).then(blob => {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'Invoice-' + inv.num + '.pdf';
    a.click();
    URL.revokeObjectURL(url);
    showToast('✓ Invoice saved to Drive & downloaded');
  }).catch(err => {
    showToast('⚠ PDF generation failed', 'error');
    console.error(err);
  });
}
```

### 7. Full Integration Flow

When Taylor taps "Generate PDF" on an invoice:

1. **App** gathers invoice data (line items, entity details, bank details, logo base64)
2. **App** calls `POST /api/generate-pdf` with full invoice payload
3. **Server** generates PDF using jsPDF matching the original layout
4. **Server** uploads PDF to Google Drive in correct folder (Entity → Year → Month)
5. **Server** appends invoice record to Google Sheets "Invoices" tab with Drive link
6. **Server** updates all related entries in "Entries" tab (invoice status → invoiced, invoice number)
7. **Server** returns PDF binary to client
8. **App** downloads PDF to Taylor's iPhone
9. **App** shows success toast
10. **App** updates localStorage and refreshes invoice screen

When Taylor logs a daily entry:

1. **App** saves to localStorage immediately
2. **App** calls `POST /api/sheets-sync` with `append_entry` action
3. **Server** appends row to Google Sheets "Entries" tab
4. **App** shows "✓ Saved to Sheet" toast on success
5. **App** shows "⚠ Save failed — tap to retry" on failure (data safe in localStorage)

On app startup:

1. **App** loads from localStorage first (instant render)
2. **App** calls `POST /api/sheets-sync` with `load_all` action
3. **Server** reads all tabs and returns JSON
4. **App** merges Sheet data with localStorage (Sheet wins on conflicts)
5. Silent — no loading spinner needed since localStorage provides instant data

---

## Current Entity Details (Hardcoded defaults in app)

### Self-Employed
- **Name:** Taylor Muir
- **Address:** 9 Queen Cathrine Road, Steeple Claydon, Buckingham, MK18 2PZ
- **Phone:** +44 7429 399687
- **Bank:** Lloyds Bank
- **Account Name:** Taylor Muir  
- **Account Number:** 45191768
- **Sort Code:** 77-21-08

### Ltd Company  
- **Company:** Hygiene and Therapy Clinical Services Ltd
- **Registered Address:** 71-75 Shelton Street, Covent Garden, London, WC2H 9JQ
- **Phone:** +44 7429 399687
- **Bank:** Lloyds Bank (same as self-employed currently, but editable)
- **Account Name:** Taylor Muir
- **Account Number:** 45191768
- **Sort Code:** 77-21-08
- **Company Number:** Needs adding to settings — ask Taylor for this

### Current Practices

**Bupa Dental Care (Contract)**
- Address: 39 Buckingham Road, Aylesbury, Buckinghamshire, HP19 9PT
- Days: Monday (1), Friday (5)
- Commission: 35%
- Services: Private (£93), Denplan (£93), Plan (£93), Legacy (£74.40)

**The Grove Dental Practice (Contract)**
- Address: 170 Tring Rd, Aylesbury, HP20 1JL
- Days: Thursday (4)
- Commission: 40%
- Services: Hygiene (£70), Perio (£160)

**Haddenham Dental (Ad Hoc)**
- Address: Banks Cottage, Banks Road, Haddenham, Buckinghamshire, HP17 8EE
- Rate: £25 per patient, £9 airflow
- No commission (billed directly)

**Bank House Dental Centre (Ad Hoc)**
- Address: 80 High Street, Princes Risborough, Buckinghamshire, HP27 0AX
- Rate: £22.50 per patient
- No commission (billed directly)

---

## NPM Dependencies for Vercel Project

```json
{
  "name": "taylor-invoices",
  "private": true,
  "dependencies": {
    "googleapis": "^118.0.0",
    "jspdf": "^2.5.1"
  }
}
```

---

## Key Technical Notes

1. **The HTML file is ~149KB** — most of that is two base64-encoded logos. These logos also need to be available server-side for PDF generation. Either extract them from the HTML at build time or store them as separate files in the project.

2. **Logo sources:**
   - Self-employed: JPEG, 360×360px, blue tooth/toothbrush design
   - Ltd: PNG, 400×267px, green "Hygiene & Therapy Clinical Services Ltd" text logo

3. **Invoice numbering** is sequential across both entities. The counter is stored in app state (`S.nextInv`) and should be synced to the Settings tab.

4. **The `S.iEnt` variable** (not `S.ent`) is used when generating invoices — it references the currently active entity. This is important because entry filtering uses `e.entity === S.iEnt`.

5. **Date format in the app** is YYYY-MM-DD internally, displayed as "11 Feb 2026" via `fdd()` helper.

6. **The app uses event delegation** for all modal buttons and archive items. Inline onclick handlers were replaced with `setTimeout(() => { el.onclick = fn }, 50)` pattern after `showModal()` calls.

7. **Commission invoices** aggregate all entries for a practice within a calendar month. Ad hoc invoices are per-entry (one invoice per ad hoc job).

8. **Perio treatments** can have multiple entries on the same day at different prices (£160, £180, £200). The duplicate detection key is: date + practice + service + unit price. Same service at same price on same day = duplicate prompt. Different prices = separate line items on the invoice.

---

## Testing Checklist

After deployment, verify:

- [ ] App loads at Vercel URL on iPhone Safari
- [ ] Log a Bupa entry → appears in Google Sheet "Entries" tab
- [ ] Log a Grove entry → appears in Google Sheet
- [ ] Log an ad hoc entry → appears in Google Sheet
- [ ] Switch entity to Ltd → log entry → Sheet shows "Ltd" in Entity column
- [ ] Generate monthly invoice for Bupa → PDF downloads as .pdf (not .png)
- [ ] PDF matches original layout with correct logo, addresses, line items
- [ ] PDF uploaded to Google Drive: Self-Employed/2026/February/Invoice-00001.pdf
- [ ] Invoice record in "Invoices" tab has clickable Drive link
- [ ] Delete an entry from archive → row removed from Sheet
- [ ] Re-download a past invoice → PDF re-downloads
- [ ] Delete a past invoice → entries reset to "pending" in Sheet
- [ ] Settings changes persist after app reload
- [ ] Day mapping works (auto-opens correct practice)
- [ ] Add new contracted practice → appears in invoices section
- [ ] Ltd invoice shows company number at bottom

---

## Files to Hand Over

1. **`taylor-invoice-manager.html`** — The complete working frontend (in outputs)
2. **`Invoice-00001.pdf`** — Original invoice template for PDF layout reference
3. **`se_logo-000.jpg`** — Self-employed logo (extracted from original invoice)
4. **`57AD44AC-C7F3-49ED-A1E5-58E41A268999.png`** — Ltd company logo (original upload)
5. **This document** — Complete handoff spec

---

## Summary of Work for Claude Code

1. **Create Vercel project** with the folder structure above
2. **Set up Google Cloud** — create project, enable APIs, create service account
3. **Create Google Sheet** with 5 tabs matching the data model
4. **Create Google Drive** folder structure (root shared with service account)
5. **Build 3 serverless functions** (sheets-sync, drive-upload, generate-pdf)
6. **Modify the HTML app** to call the API endpoints instead of (or in addition to) localStorage
7. **Replace canvas PDF generation** with calls to `/api/generate-pdf`
8. **Deploy and test** on Vercel
9. **Get Ltd company number** from Taylor and add to settings
