# Taylor Invoice Manager

Mobile-first PWA for dental hygienist invoice management.

## Features

- Log daily patient work with practice and service selection
- Auto-calculate commission (35% Bupa, 40% Grove)
- Generate professional PDF invoices
- Sync to Google Sheets for data backup
- Upload PDFs to Google Drive with organized folder structure
- Entity switching (Self-Employed / Ltd Company)

## Setup

1. Clone this repository
2. Copy `.env.example` to `.env.local` and fill in values
3. Run `npm install`
4. Run `npm run dev` for local development

## Deployment

Connected to Vercel for automatic deployments:
- Push to `main` branch triggers production deploy
- Environment variables configured in Vercel dashboard

## Environment Variables

Set these in Vercel Dashboard > Settings > Environment Variables:

| Variable | Description |
|----------|-------------|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email from Google Cloud |
| `GOOGLE_PRIVATE_KEY` | Private key from service account JSON |
| `GOOGLE_SHEET_ID` | ID from Google Sheet URL |
| `GOOGLE_DRIVE_FOLDER_ID` | ID of root Drive folder for PDFs |

## API Endpoints

- `POST /api/sheets-sync` - Google Sheets CRUD operations
- `POST /api/drive-upload` - Upload files to Google Drive
- `POST /api/generate-pdf` - Generate and save invoice PDFs

## Tech Stack

- Frontend: Vanilla JavaScript (single-file HTML app)
- Backend: Vercel Serverless Functions
- PDF: jsPDF
- APIs: Google Sheets API, Google Drive API
