# Haptags Hub

The operations back office for Haptags LLP: leads, clients, projects, quotations, GST invoices,
payments, retainers, support and a client portal. It runs alongside the marketing site at
haptags.com, which stays as it is.

| Area | What it does |
|---|---|
| Dashboard | Money collected per month, outstanding and overdue, MRR, pipeline by stage, win rate, and the day's to-do list (new leads, follow-ups, overdue invoices, payments to verify, support, projects due, retainer upsells). |
| Leads | Every enquiry from the website API, the hosted `/start` form, WhatsApp, calls and referrals. Repeat enquiries merge into the open lead. Stages, follow-up dates, owner, and a call/WhatsApp/meeting log. One click creates the client and a quote. |
| Quotations | Numbered per financial year. Shared by link or WhatsApp, and the client accepts online, which marks the lead won. Converts to an invoice. |
| Invoices | GST tax invoices: CGST+SGST within Karnataka, IGST for other states, none when there's no GSTIN. Numbers are gap-free per FY (`HT/26-27/0001`), assigned on issue. Issued invoices can only be voided. Amount in words, print to PDF. |
| Payments | Razorpay (UPI/cards/net-banking) with signature checks and a webhook. A UPI QR with the amount pre-filled (no fees). Bank transfer. Clients can report a UTR, and the team confirms it. Partial payments and TDS are supported. Receipts are emailed. |
| Retainers | Monthly, quarterly, half-yearly or yearly plans that raise and email their own invoices. MRR tracking. A list of completed projects with no plan, to upsell. |
| Automation (hourly) | Marks invoices overdue, bills retainers, expires old quotes, and sends payment reminders 3 days before the due date, on the due date, then 3, 7, 14 and 30 days after. |
| Client portal | Projects with milestones, updates and files, invoices with Pay now, quotations to approve, and support tickets. Each client sees only their own data. |
| Team | Owner, admin and staff roles. Invites by email or a copyable link. Email log. |
| Chat | Public and private channels, 1:1 and group chats, files up to 8 MB (paste, drag or attach), @mentions, edit and delete, typing and online indicators, unread badges. **Call** starts a video call with everyone in the conversation and rings their tabs. |
| Meetings | Schedule with team members and outside guests. Invitations are emailed with a calendar invite (Gmail/Outlook Yes/No buttons, 10-minute alert). **Meet now** opens an instant room. Join links can be shared on WhatsApp. RSVP, edit, and cancel with notice. |
| Video room | Runs in the browser at `/meet/<link>`. Camera and mic check before joining, screen sharing, raise hand, reactions, in-call chat, and speaking indicators. Guests wait in a lobby until a team member admits them. Hosts can mute or remove people, or end the meeting for everyone. |
| Calendar | A month view of your meetings, project deadlines and lead follow-ups (yours or the whole team's). Click a day to schedule. |
| Announcements | Owners and admins post, with options to pin, mark important and email the team. They show on everyone's dashboard until read, and admins can see who has read each one. |
| Education | College students and interns, kept apart from business clients. Programs with fees (GST-inclusive or not). Enrolling a student creates their invoices in a separate series (`HTE/26-27/0001`), split into monthly instalments if wanted, and records money taken at the counter. Students pay by UPI, card or Razorpay from the invoice link, and reminders run automatically. The dashboard shows billed, collected and outstanding by program, batch and college. CSV export. |
| Certificates | Pulled from lms.haptags.com: **Sync from LMS** (and an hourly automatic sync) copies every certificate the LMS has issued, with its PDF, and files it under the matching student (or adds the student). Certificates can also be fetched by ID or uploaded on a student's page. The LMS's verify and PDF endpoints are public, so no LMS changes or keys are needed (`LMS_API_URL`, default `https://lms.haptags.com/hcgi/api`). |
| Import past students | Education → Students → **Import CSV** (template provided): each row creates the student, their invoice (your own number and date if given) and payment, and attaches their LMS certificate. No emails are sent, and re-importing doesn't duplicate. |
| Finance & costs (owners/admins) | Upload bank statement CSVs from any Indian bank. Re-uploading overlapping statements skips lines already imported. Lines are categorised by your rules, then by client and student names, then by built-in keywords (salaries, rent, ads, hosting, software, GST, TDS, bank charges…). Money in is matched to payments recorded in the Hub, and to open invoices with one-click recording. The CEO view, for any period or all time, covers revenue by source, every cost as a % of spend and of revenue, net margin, monthly burn and runway, opening and closing balances, billed vs collected, GST charged vs paid, and top payees and payers. CSV export for the CA. |

Notifications arrive live in any open Hub tab (toasts and badges), and as desktop notifications
when the tab is in the background.

## GST Invoices (`/invoices`, owners and admins only)

A separate module for tax invoices under CGST Rule 46, with its own clients, services, payments
and business profile. It has its own sidebar item under **GST**, which only owners and admins see;
staff get "not allowed" if they open the link.

| Area | What it does |
|---|---|
| Business profile | Legal and trade name, GSTIN, PAN, registration date, address, bank, SWIFT and UPI, LUT ARN and validity, signatory, logo and signature, prefixes, default GST rate, payment terms and terms & conditions. It starts from the GST certificate (REG-06, 28/10/2026) and the signed stamp. |
| Clients | B2B (GSTIN checked, including its check digit, and the state taken from its first two digits), B2C, and export. **Copy from Hub** brings over the Hub's business clients. Clients are deactivated, never deleted. |
| Services | Saved lines with SAC, unit, rate and GST rate. Pre-loaded with 998314, 998313, 998365 and 999293, all editable. |
| Tax invoices | `HT/26-27/0001` style numbers, at most 16 characters, consecutive per financial year (April to March). A number is taken on **Finalise** and never reused; a cancelled invoice keeps its number. Same state as the GSTIN: CGST + SGST. Other states: IGST. Overseas: 0% IGST under LUT, in USD, EUR or GBP with the INR equivalent. Tax is worked out per line, totals are rounded to the rupee, and the amount is shown in words (lakh/crore). Finalised documents are locked. |
| Proformas, notes | Proformas (`PF/…`) convert to a draft tax invoice in one click. Credit notes (`CN/…`) and debit notes (`DN/…`) link to the invoice they adjust and update its balance. |
| PDF | A4, "TAX INVOICE" / "EXPORT INVOICE" / "PROFORMA INVOICE" / "CREDIT NOTE" / "DEBIT NOTE", marked original for recipient, with an optional duplicate for supplier. Includes the tax summary by SAC, bank details, a UPI QR for the amount due, and the signature. Download, print, or email it to the client as an attachment. |
| Payments | Full or partial, by UPI, NEFT, RTGS, IMPS, cheque, cash or international wire, with TDS (194J at 10% or 2%, 194C) worked out on the taxable value. A wrong payment is reversed, not deleted. Status is Draft, Unpaid, Partially paid, Paid, Overdue or Cancelled. |
| Dashboard | Invoiced this month and in the period, collected, outstanding, overdue, and GST split into CGST, SGST and IGST. Also invoiced vs collected per month, top clients and overdue invoices. Filters by date range, financial year, client and status. |
| Reports | Sales register (Excel/CSV), a GSTR-1 workbook (b2b, b2cl, b2cs, exp, cdnr, cdnur, hsn(b2b), hsn(b2c), docs) and outstanding receivables with ageing. |
| Safety | An audit log records who did what, when, and from which IP. Documents, lines and payments are never deleted, and database triggers refuse it. A daily gzipped JSON backup goes to `~/haptags-hub-backups` in production (outside the app folder that each deploy replaces), `data/backups/` locally, or `GST_BACKUP_DIR`. The last 30 are kept. A backup can also be downloaded from the profile page. |
| E-invoicing | Not switched on (needed above ₹5 crore turnover). `src/lib/gst/einvoice.js` builds the IRP request (schema 1.1) from any B2B or export document. The PDF prints the IRN, acknowledgement and signed QR once they are saved. |

The GST module and the older **Invoices** screen share one counter per prefix, and each checks the
other's numbers, so a number is never issued twice under the GSTIN. To give GST invoices a fresh
series, change the tax invoice prefix on the Business Profile page.

### How the real-time parts work

- Browsers long-poll `/api/rt/poll`. This works through Hostinger's proxy, where WebSockets
  often don't. Events stay in memory for a few minutes, and the database stays the source of
  truth, so after a restart tabs reconnect and reload anything they missed.
- Video is peer-to-peer WebRTC: every participant connects to every other one, and the server
  only relays the connection handshake. That suits calls of up to about 6–8 people with video
  (more with cameras off).
- The real-time state lives in one Node process. Run the app as a single instance.
- STUN servers (Cloudflare and Google) let most networks connect directly. A few corporate and
  mobile networks block that. For those, add a TURN relay with `TURN_URL`, `TURN_USERNAME` and
  `TURN_CREDENTIAL`, for example a self-hosted coturn or a hosted provider.

## Run locally

```bash
npm install
npm run seed-demo      # optional demo data (SQLite only)
npm run dev            # http://localhost:3000
npm test               # end-to-end flows
```

Demo sign-ins: `demo@haptags.local` (owner), `staff@haptags.local` (staff) and `client@haptags.local`,
all with the password `demo-password-123`. To try a call, open a meeting in one browser and its
link in a private window.

Without `DB_HOST` the app uses SQLite at `data/hub.sqlite`. With `DB_HOST` it uses MySQL. Migrations
run automatically on start.

## Deploy (Hostinger Node.js)

1. Create a website for `hub.haptags.com` and a MySQL database for it.
2. Upload this folder as a zip, without `node_modules` or `data`. Use app type Express,
   entry file `server.js` and Node 22.
3. Set the environment variables from `.env.example`. The essentials are `NODE_ENV`, `BASE_URL`,
   `SESSION_SECRET`, `DB_*`, and `ADMIN_*` for the first run.
4. Sign in, change the password under **My account**, and fill in **Settings**: GSTIN, bank, UPI ID
   and terms.

## Connect the haptags.com enquiry form

The live site's `/api/lead` handler can forward each enquiry server-to-server. Keep the key on the
server; it is under Settings → Integrations.

```php
// After the lead is saved in /api/lead:
$ch = curl_init('https://hub.haptags.com/api/v1/leads');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 5,
  CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . getenv('HUB_LEAD_KEY')],
  CURLOPT_POSTFIELDS => json_encode([
    'name' => $name, 'email' => $email, 'phone' => $phone, 'company' => $company,
    'service' => $service, 'budget' => $budget, 'timeline' => $timeline,
    'message' => $message, 'source' => 'website', 'source_detail' => $kind,
  ]),
]);
curl_exec($ch);
curl_close($ch);
```

The field names match the existing form (`service`, `budget` and `timeline` values included). The
API answers `201` for a new lead and `200` with `duplicate: true` when the enquiry merged into an
open lead.

## Haptags LMS doubt sessions

lms.haptags.com students on the full package get a daily live doubt-clearing session per course.
The LMS server calls `POST /api/v1/lms/doubt-session` with header `X-API-Key` and
`{ course_slug, course_title, student_email, student_name }`. Hub creates that course's meeting
for the day the first time it's requested (organised by the first owner, or `LMS_HOST_EMAIL`),
adds the student as a guest, and emails them the calendar invite once. It answers with
`join_url`, `starts_at` and `duration_min`. After today's session ends, it returns tomorrow's.

The sessions show up in the organiser's Meetings and Calendar like any other meeting. Students
wait in the lobby until someone from the team admits them.

| Variable | Default |
|---|---|
| `LMS_SESSION_TIME` | `19:00` (IST) |
| `LMS_SESSION_MINUTES` | `60` |
| `LMS_HOST_EMAIL` | first owner |
| `LMS_KEY_SHA256` | SHA-256 of the key that lms.haptags.com uses |

## Razorpay

1. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. A **Pay online** button then appears on unpaid
   invoices.
2. Under Webhooks, add `https://hub.haptags.com/webhooks/razorpay` with the event `payment.captured`.
   Use the same secret as `RAZORPAY_WEBHOOK_SECRET`. The webhook records payments even if the
   client closes the browser, and it never double-counts.

## Code map

```
server.js                 start: migrate → owner bootstrap → listen → scheduler
src/app.js                security headers, sessions, layouts, routing
src/migrations/           schema (money in paise, dates as YYYY-MM-DD)
src/lib/billing.js        numbering, GST, invoice status, payments, quote/retainer → invoice
src/lib/automation.js     hourly jobs (overdue, retainers, reminders, quote expiry)
src/lib/leads.js          enquiry validation, de-duplication, notifications
src/routes/public.js      /start, lead API, shareable invoice/quote pages, Razorpay
src/routes/admin/*        team back office
src/routes/portal.js      client portal
src/lib/gst/              GST Invoices: tax.js (arithmetic), documents.js (draft → finalise → cancel),
                          numbering.js, payments.js, pdf.js, gstr1.js, reports.js, einvoice.js, backup.js
src/routes/gst/           /invoices routes (owners and admins)
src/views/                EJS templates (partials/document.ejs = invoice/quote layout; gst/ = GST Invoices)
test/flows.test.js        end-to-end tests
test/gst.test.js          GST Invoices tests
```
