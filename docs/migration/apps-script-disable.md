# Disabling the BooksIQ Apps Script triggers (for Taylor)

Hi Taylor — your BooksIQ data has been moved to the new central
storage. Your old Apps Script that auto-generates and deletes
invoice PDFs in your Drive is no longer needed. Please follow the
steps below to switch off its automatic triggers so it doesn't keep
running in the background.

> Don't worry about deleting the script itself — leaving it sitting
> there uses no resources once the triggers are off. We're only
> turning off the **automatic schedule**.

## Steps

1. Open https://script.google.com in any browser. Sign in with the
   Google account where your old BooksIQ sheets used to live.

2. In the list of projects, look for one called **BooksIQ Invoice
   PDF Generator** (the exact name may vary — anything with
   "BooksIQ" or "Invoice" in the title is the right one). Click it.

3. On the left-hand sidebar, click the **clock icon** (Triggers).
   You'll see a list of one or more triggers — they normally have
   names like `processTrashTab`, `onEdit`, `processQueueTab`, etc.

4. For **each trigger** in the list:
   - Hover over the row
   - Click the three-dots menu (⋮) on the right
   - Click **Delete trigger**
   - Confirm

5. Once the list is empty, you're done. The script project itself
   can stay where it is — it will simply never run again.

## How to confirm it worked

After deleting the triggers, you can do one of these to be sure:

- Reload the Triggers page — it should say *"No triggers yet"*.
- Check your Gmail in 24 hours — if the script was previously
  emailing you about errors, those emails should stop.

## What if I see a problem with my account in the next few weeks?

- **Don't re-enable the triggers**. They were targeting the old
  storage and won't help.
- Email Marcus directly. He has a one-command rollback that puts
  your account back exactly the way it was before the migration; it
  takes a few minutes and you won't lose anything.

## Why we're doing this

Before today, your BooksIQ invoices were stored in your own Google
Drive, and the Apps Script was needed because the BooksIQ servers
weren't allowed to delete files they didn't own. With the new setup,
the BooksIQ servers own all your invoices in their central storage
(you still have full editor access to your folder, shared back to
your email), so the script is no longer needed.

Thanks for your patience!
