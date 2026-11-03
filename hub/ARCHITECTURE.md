# Haptags Portal: architecture and build brief

A single Node web app for Haptags LLP (Bengaluru). It gives the Haptags team one **company view** to run clients, projects, billing, GST invoicing, education and sales, and gives each client a small, safe **client portal**.

Use this document as the brief to build or rebuild the project. Follow the rules in sections 2 and 9 exactly; they are the product.

---

## 1. What it does

| Area | Who uses it | What it covers |
|---|---|---|
| **Company view** `/team` | Haptags owners, admins, staff | Overview, Clients, Projects and tasks, Billing (quotations, invoices, receipts), GST Invoices, Education, Income and expenses, Sales, Support inbox, Chat and calls, Meetings, Leave, Team |
| **Client portal** `/portal` | The client's own people | Their project progress, updates, files, invoices (read only), one group chat with Haptags, support requests, their account |
| **Public pages** | Anyone with a link | Sign in, set or reset password, public invoice link `/i/:token`, offer letter link `/o/:token` |

---

## 2. Roles and access rules (the core of the product)

Roles: `owner`, `admin`, `staff` (Haptags side) and `client` (a person at a client company).

| | Owner | Admin | Staff | Client |
|---|---|---|---|---|
| Overview, clients, projects, tasks | yes | yes | yes, **no money shown** | no |
| Billing, invoice generator, record payments | yes | yes | no | read-only view of their own invoices |
| Income and expenses | yes | yes | no | no |
| GST Invoices, Education | yes | yes | no | no |
| Sales: log and view | everyone's | everyone's | **own only** | no |
| Support, chat, meetings | yes | yes | yes | own requests and **one group chat** |
| Leave | request (auto-approved), approve all | request, approve staff | request | no |
| Add or archive clients, invite client people | yes | yes | no | no |
| Add team members, edit, reset passwords, remove | yes | yes | no | no |

Hard rules:
- **Clients see only the projects they were invited to**, per person (a project list, or "all projects including future ones"). Invoices follow the same limit; company-wide people also see invoices that belong to no project.
- **Clients have one group chat** per client company, with the Haptags contacts assigned to that client. No direct messages to other staff.
- **Clients have no Projects page, no task board, no "approve" actions.** Billing is read-only for them.
- **Clients cannot see the team features at all.** The client portal has no menu item, link, button, label or mention of anything that belongs to the company view (Projects board, tasks, Sales, GST, Education, Team, finance). The client UI is built only from the client pages; it is not the team UI with things hidden. A client never sees an error page as part of normal use, because nothing in their portal leads to a team feature.
- **Staff never see money.** Owners and admins do. Staff get 403 on billing, GST and education pages.
- Internal task notes (`internal = true`) are never shown to clients.
- Students (clients with `segment = 'student'`) live under Education only and never appear in the Clients list.

---

## 3. Tech stack

- **Node 20+** (built on Node 24), **Express 5**
- **EJS** server-rendered views with layouts; vanilla JS in `public/js`, no front-end framework or build step
- **knex** migrations and queries. **SQLite** (`better-sqlite3`, default) or **MySQL** (`mysql2`, production on shared hosting)
- `cookie-session` (signed cookie), `bcryptjs` (cost 11), `helmet` (CSP, HSTS), `express-rate-limit`
- `nodemailer` (SMTP, for example Gmail or Hostinger), `pdfkit` (PDF invoices and offer letters), `qrcode` (UPI QR)
- **Razorpay** for online payments (optional)
- `@mediapipe/tasks-vision` for video-call background effects
- Realtime without WebSockets: an in-process event bus that browsers **long-poll** (`/api/rt/poll`), so it works behind any proxy. Run **one instance only**.
- Tests: `node --test` (no framework). 56 tests against a throwaway SQLite file.

---

## 4. Folder structure

```
server.js                 start: load config, run migrations, ensure owner, listen
src/
  app.js                  middleware order, layout chooser, route mounting
  config.js               env parsing, production guards
  db.js                   knex instance, migrate()
  lib/                    business logic (no HTTP)
    auth.js  middleware.js  bootstrap.js  invites.js  settings.js  util.js  money.js
    view-helpers.js  icons.js  mailer.js  notifications.js  realtime.js  rooms.js
    chat.js  clientchat.js  meetings.js  leave.js  holidays.js  scope.js
    billing.js  billdocs.js  razorpay.js  automation.js  finance.js  charts.js
    education.js  certificates.js  lms-programs.js  lms-invoices.js  student-import.js  offers.js  offer-pdf.js
    gst/                  profile, clients, documents, numbering, tax, gstin, gstr1, einvoice,
                          payments, pdf, xlsx, reports, backup, audit, mail, words, triggers
  routes/
    auth.js  public.js  webhooks.js  realtime.js  meet.js  lms.js
    portal.js  portal-chat.js          client side
    team.js                            company view (mounts the rest below)
    team-people.js  team-sales.js  team-leave.js  team-finance.js
    gst/                               GST invoices (mounted at /team/gst)
    admin/education.js, offers.js ...  Education (mounted at /team/education); the rest of
                                       routes/admin is a legacy back office, OFF unless ENABLE_ADMIN=1
  migrations/             001 to 025, run in order automatically on start
  views/
    layouts/              portal.ejs (team and portal), public.ejs, admin.ejs, doc.ejs, room.ejs
    team/ portal/ gst/ admin/ auth/ public/ meet/ partials/
public/                   css (app, portal, workspace, billing, gst, offer, board, room), js, img, vendor
scripts/create-admin.js   create or reset an owner/admin from the command line
scripts/demo/             optional demo data (npm run seed-demo); never run in production
test/                     flows, portal, gst, offers, programs, team, lms-invoices
data/                     SQLite file and backups (not committed)
```

---

## 5. Request pipeline and URL map

Middleware order in `src/app.js`: helmet, static files, `/healthz`, `/webhooks` (before body parsing, for signature checks), body parsers, cookie-session, layout chooser, settings and view helpers, `loadUser`, flash messages, CSRF, then routes.

- **Layout is chosen by view folder:** `admin/*` uses the admin layout, `portal/*` and `team/*` use the portal layout (team shell), everything else the public layout. A route can set `layout` to override (GST and education force `portal`).
- `/` redirects by role: team to `/team`, client to `/portal`.
- `/team/*` needs a Haptags role (`requireStaff`); `/portal/*` needs a client (`requireClient`). A client has no way to reach a team page from their portal, and the server also refuses them if they type a team address by hand, without revealing anything about it. A signed-out visitor goes to `/login?next=`.
- `/team/*` mounts: `clients`, `projects`, `tasks`, `support`, `billing`, `people`, `sales`, `leave`, `finance`, `gst`, `education`, `chat`.
- Old addresses redirect: `/invoices` to `/team/gst`, `/admin/education` to `/team/education`.
- The lms.haptags.com API (`routes/lms.js`: doubt sessions and LMS payment invoices) is always mounted, because the LMS server calls it; only the legacy back office screens depend on `ENABLE_ADMIN`.
- **Sessions:** the cookie holds `uid`, token version and a CSRF token. Changing a password, removing someone or archiving their client bumps `token_version`, which signs them out everywhere. An invalid session becomes an empty session (not null) so later middleware keeps working.
- **CSRF:** every POST needs the `_csrf` field or `x-csrf-token` header, except `/api/*` and `/webhooks/*`.
- **Navigation** for `/team` is built per request in `routes/team.js`, so money pages show only to owners and admins.

---

## 6. Data model (knex migrations 001 to 025)

Core: `settings` (key/value), `sequences` (gap-free numbers), `users`, `clients`, `activities`, `email_log`, `files`.

- **users:** name, email (unique), role, password_hash, is_active, token_version, client_id (for client people), job_title, invite token hash and expiry, last_login_at, `all_projects` flag.
- **clients:** name, contact, email, phone, gstin, address, city, state, status (`active` | `archived`), **segment (`business` | `student`)**, program_id for students.
- **Projects:** `projects` (client, status, progress, due date), `project_tasks` (status todo/doing/review/done), `task_comments` (with `internal`), `project_members` (which client person sees which project), `project_updates`, `project_files`, `milestones`, `project_links`.
- **Billing:** `quotes`, `invoices`, `line_items`, `payments`, `razorpay_orders`, `retainers`, `billing_docs` (quotation, invoice, receipt from the generator).
- **GST module:** `gst_*` tables for its own clients (linked to hub clients by `hub_client_id`), services, documents (invoice, proforma, credit and debit notes), payments, audit trail and business profile. Numbers are gap-free per financial year.
- **Education:** `programs`, student rows in `clients` with `segment = 'student'`, student fee invoices in their own series (`HTE/...`), `certificates`, `offer_letters` (internship offer letters with a public accept page).
- **Finance:** `bank_imports`, `bank_txns`, `bank_rules` (bank statement CSV to categorised income and expense), `partners`.
- **Collaboration:** `channels` (a client's group chat has `client_id`), `channel_members`, `messages`, `meetings`, `meeting_invitees`, `announcements`, `announcement_reads`, `notification_reads`, `tickets`, `ticket_messages`, `lms_sessions`.
- **People:** `leave_requests`, `holidays`, `client_contacts` (which Haptags people a client can see and message).
- **LMS invoices:** `lms_invoices` (one row per LMS order: merchant order id, the GST document issued for it, the student client).
- **Sales (new):** `sales` (user_id credited to, optional client_id, customer, title, **amount in paise**, sale_date, status `won` | `pipeline`, notes, created_by).

Conventions:
- **All money is an integer in paise** (₹1 = 100). Convert with `lib/money.js` (`toPaise`, `formatINR`). Never store floats.
- Dates are stored as `YYYY-MM-DD`; "today" and month boundaries use **IST** (`todayIST()`).
- Foreign keys are on in SQLite. Deleting a client cascades its projects and logins, so deleting is only allowed for an archived client with **no** invoices, quotes, billing docs, payments or GST records.

---

## 7. Feature behaviour worth copying exactly

**Team members** (`/team/people`): owners and admins add someone with a name, email, role (Admin or Staff) and job title. They either set a password (the person signs in at once) or leave it empty to email an invite link that works for a set number of days. They can edit name and job title, set a new password, change the role, remove or restore access, and resend an invite. The owner account and your own access can't be changed here. The page shows each member's online state, last seen and (to owners and admins) sales this month.

**Clients** (`/team/clients`): a quick-add row (company, contact, email, first project) that creates the client, its first project, one group chat, and invites the contact to that project only. A fuller form takes GSTIN and address. A client page manages its people (per-person project access, resend invite, remove), Haptags contacts, projects and billing. **Archive** hides a client, signs its people out and stops sign-in; **Restore** brings it back; **Delete** is for archived, never-billed clients only.

**Sales** (`/team/sales`): anyone on the team logs a sale (what, to whom, amount in ₹ before GST, date, Closed or In talks, notes). Owners and admins see all entries, a per-teammate ranking with share of total, a top seller, filters by month and person, and can credit a sale to another teammate or edit and delete any entry. Staff see and edit only their own. Amounts above ₹100 crore are rejected as a typo. Another person's entry returns 404.

**Billing and GST:** quotation, invoice and receipt generator with public share links and PDF; the separate GST module issues tax invoices under CGST Rule 46 (CGST+SGST within Karnataka, IGST elsewhere, none without a GSTIN), proformas, credit and debit notes, GSTR-1 workbook and e-invoice data. Issued invoices can only be cancelled, not edited. Three one-off migrations (010, 011, 015) reset trial GST data, move numbering into the `HTG` series and renumber CMR’s invoice to HTG/26-27/0001, each with an automatic backup first. Every lms.haptags.com payment becomes a finalised, paid `HTG` tax invoice through `POST /api/v1/lms/invoice` (`lib/lms-invoices.js`, table `lms_invoices`); the same order always returns the same invoice.

**Education:** students, programs with fees, instalments, counter payments, UPI/card/Razorpay payment from an invoice link, automatic reminders, certificates fetched from the LMS, CSV import of past students, and internship offer letters (PDF plus a public accept page).

**Chat and calls:** one-to-one and group channels for the team; each client gets exactly one private group with its Haptags contacts. Video and audio calls and meetings use WebRTC with in-process signalling (optional TURN server), with a lobby, screen share and background effects.

**Leave:** casual, sick, earned and unpaid leave with balances, working-day maths that skips weekends and holidays, approval by owners and admins, and a "who's away" list.

**Finance (owners and admins):** upload bank statement CSVs, categorise lines by rules, client and student names and built-in keywords, match money in to recorded payments, and see revenue, costs, net margin, burn and runway.

**Theme:** Light, Dark and Auto (follows the device), stored in `localStorage` as `hub-theme`, applied before paint by `public/js/theme-init.js`.

---

## 8. Configuration (environment variables)

`NODE_ENV`, `PORT`, `BASE_URL`, `SESSION_SECRET` (long and random, required in production), `DB_HOST/PORT/NAME/USER/PASSWORD` (MySQL; omit for SQLite, or set `SQLITE_FILE`), `ADMIN_NAME/EMAIL/PASSWORD` (creates the first owner on start; remove the password afterwards), `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`, `NOTIFY_EMAIL`, `RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET`, `CRON_KEY`, `GOOGLE_CLIENT_ID/CLIENT_SECRET` (optional "Continue with Google": existing accounts only, matched by verified email; `lib/google.js`), `TURN_URL/USERNAME/CREDENTIAL`, `GST_BACKUP_DIR`, `LMS_API_URL` (empty to disable the LMS link), `ENABLE_ADMIN` (legacy back office, keep off).

Gmail SMTP: `smtp.gmail.com`, port 465, an app password, `MAIL_FROM` equal to the signed-in Gmail address.

---

## 9. Security rules

- Passwords: at least 8 characters, bcrypt. Invite and reset links use random single-use tokens stored as SHA-256 hashes, with an expiry.
- Production: `trust proxy 1`, `secure` cookie, helmet CSP and HSTS, rate limits on sign-in and reset, `/healthz` for uptime checks.
- Every state-changing form is CSRF-protected. User input is length-limited with `str()` and `int()` helpers; EJS output is escaped by default.
- Authorisation is checked on the server for every route (role, ownership of a sale or task, client scope). Hiding a button is never the only protection.
- No demo accounts, auto-login or "view as" switcher exist in the app. Demo data is a separate script and refuses production.
- Never store secrets in the repo. `.env` is ignored; `.env.example` lists names only.

---

## 10. Deploy and operate

1. Upload the project, run `npm ci` (`.npmrc` sets `ignore-scripts=true` so `better-sqlite3` installs from its prebuilt binary without a compiler).
2. Set the environment variables above. `NODE_ENV=production`.
3. **Back up the database before the first start of a new version**; migrations run automatically.
4. Start with `npm start` (`node server.js`). One process only, behind an HTTPS reverse proxy.
5. Create the first owner through `ADMIN_*` or `npm run create-admin -- --name "X" --email x@y.com --password "..." --role owner`.
6. Fill GST Invoices, Business profile (GSTIN, bank, UPI, signature) and connect SMTP.

---

## 11. Suggested build order

1. Config, db, migrations 001 onward, auth (sign in, invite, reset), roles and CSRF.
2. Layouts, theme, navigation, flash messages.
3. Clients, client people and per-project access, projects and tasks, client portal.
4. Client group chat and the realtime bus; then team chat, meetings and calls.
5. Billing documents, invoices, payments, Razorpay, public invoice link.
6. GST module and its migrations; Education and offer letters.
7. Finance import, Leave, Support.
8. Team management, Sales, client archive and delete.
9. Tests for every rule in section 2, then production hardening.

Write a test for each access rule in section 2 as you go: a client must not see another client's project, a staff member must not reach `/team/billing`, a client's portal contains no link to any team feature and typing a team address gives them no access, and so on.
