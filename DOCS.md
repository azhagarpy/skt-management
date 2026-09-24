# Northstar — quick reference

Minimal operating notes. `README.md` covers installation and the codebase layout;
this file covers what the application *does*, in the order you use it.

---

## Roles

| Role | Scope | Notes |
| ---- | ----- | ----- |
| `SUPER_ADMIN` | Everything (all 80 permissions) | Administrative account, **not** an employee — no attendance, leave, salary or payslips of their own |
| `SUPERVISOR` | Their assigned team | Team salary, team payroll and team reports are **not** granted by default — grant per user from Users |
| `EMPLOYEE` | Themselves only | — |

The role is only a starting set. Any single permission can be granted or revoked
per user from **Users**, which is how "this one supervisor may see team salary"
is expressed without adding a fourth role. The sidebar builds itself from the
signed-in user's permissions.

---

## Setup order

Each step depends on the ones above it.

1. **Organization → Profile** — name, address, tax IDs, and the establishment's
   Labour Identification Number (printed on every Letter of Appointment).
2. **Organization → Branding** — logo and theme colour (see below).
3. **Organization → Departments / Sections / Locations** — every employee is filed under these.
4. **Salary → Components**, then **→ Structures** — components first; a structure is assembled from them.
5. **Leave → Leave types** — `isPaid`, `excludeWeeklyOff`, `excludeHolidays` and
   `sandwichHolidays` are read by the payroll engine.
6. **Calendar** — holidays and weekly offs. This defines what a working day is.
7. **Salary → PF, ESI & policy** — statutory rates and how paid days are counted.
8. **Employees → Add employee** — optionally creating a login at the same time.
9. **Salary → Assign salary** — until this exists, payroll produces no line for that employee.

---

## Monthly cycle

**Through the month**

- **Attendance** — marked daily or in bulk. Each day is one of `PRESENT`, `ABSENT`,
  `ON_LEAVE`, `HALF_DAY_LEAVE`, `HOLIDAY`, `WEEKLY_OFF`.
  **Face ID import** (Attendance → *Import sheet*): upload the entrance system's `.xlsx` — a
  *Muster Report* (P/A/HF/WO per day) or a *Daily Present Report* (punch rows = present). Rows
  match on Person Id = employee code; pick every day, one day or a range. Admins update
  everyone in the sheet, supervisors only their direct reports (not themselves). Days that
  already have different attendance need an explicit *override* or *keep existing* choice.
  Approved-leave and payroll-locked days are never changed. `HF` becomes an unpaid half day.
  Endpoints: `POST /attendance/import/preview` (dry run) and `POST /attendance/import`.
- **Leave** — employee applies → supervisor or admin approves/rejects → an approved
  request writes back into attendance. Statuses: `PENDING` `APPROVED` `REJECTED` `CANCELLED`.
  **Sandwich rule** (`sandwichHolidays`, on by default): a holiday with a full day of
  leave immediately before it *and* immediately after it is charged as leave too. The
  leave either side may belong to a different request, so a charged holiday can fall
  outside the dates the employee asked for — a Friday request and a Monday request with
  a holiday on the Saturday between them costs three days, not two. An unbroken run of
  holidays counts as one sandwich; a weekly off between the leave and the holiday breaks
  the run and nothing is charged.
- **Bonuses** — attached to a payroll *month*, not a date. Only `APPROVED` bonuses are
  paid; `PENDING` ones are ignored by the calculator.
- **Tax** — the tax amount for each band of wages (Tax → Tax slabs). The tax report
  applies the bands to each employee's *total wages over a period* (usually a
  half-year) and exports the P.TAX workbook, a sheet per department. From the
  report an administrator chooses the payroll month the tax comes out of pay
  ("Deduct from salary"); payroll then deducts it as a `P.Tax` line when it
  calculates that month. Repeating it for the same month replaces it, until that
  payroll is approved. There is no deductions module; PF, ESI and P.Tax are the
  payroll deductions besides salary-structure components and adjustments.

**At month end**

```
DRAFT ──calculate──> CALCULATED ──(optional)──> UNDER_REVIEW
                          └──────approve───────────────┘
                                      ↓
                                  APPROVED ──lock──> LOCKED
```

| Transition | Allowed from | Refused when |
| ---------- | ------------ | ------------ |
| Calculate | `DRAFT` | — |
| Submit for review | `CALCULATED` | any other status |
| Approve | `CALCULATED`, `UNDER_REVIEW` | the run has no items |
| Lock | `APPROVED` | any other status |
| Record a payment | `APPROVED`, `LOCKED` | already paid in full, or dated before the period starts |
| Raise an adjustment | `LOCKED` | — |

Payment status is separate from run status: `PENDING` → `PARTIALLY_PAID` → `PAID`.
A run can be locked while money is still going out. Employees see their payslip
once the run reaches `APPROVED`.

**What the calculator reads** — the employee's salary structure and components,
every day of the month resolved against the calendar, whether each leave day was
paid, approved bonuses for that month, the tax set to be deducted, and the PF and ESI rules on the salary structure.

**Documents** (Payslips & letters) — payslips for any approved month, a No Objection
Certificate, and the statutory **Letter of Appointment** under the Code on Social
Security, 2020. The letter's sixteen particulars are filled from the employee record,
so the profile (parent's name, category of skill, nature of duties), the Aadhaar, PF
and ESI details, the organization's LIN and the current salary assignment all need to
be in place before it is issued; a particular with nothing on record prints as "NA".

---

## Branding

Set from **Organization → Branding**; applies without a deploy.

| What | Source | Applied to |
| ---- | ------ | ---------- |
| Name | `organizations.name` (Profile tab) | sidebar, browser tab title |
| Logo | `organizations.logo_path` | sidebar; falls back to the name's initials |
| Accent | `organizations.theme_color` | the whole `--brand-*` ramp, and dashboard charts |

One hex value is stored; `BrandingProvider` derives the six `--brand-*` stops and
sets them on the root element. Defaults live in `src/styles.css` (indigo `#5b54d6`).
Logos are PNG or JPEG up to 2 MB, byte-sniffed on upload and streamed only after a
permission check. The sign-in screen is deliberately unbranded — there is no
authenticated organization context before sign-in.

---

## WhatsApp messaging

Two ways a message leaves the system, both writing to one delivery log:

- **Scenarios** fire automatically on an event. Configured per event under
  **Messaging → Scenarios**, and off until an admin turns one on.
- **Broadcasts** are sent deliberately to chosen people under **Messaging → Send
  a message**, in the app, on WhatsApp, or both.

### The template constraint

WhatsApp refuses free-form business-initiated messages. Anything sent outside the
24-hour window after someone writes to you must use a template **already approved
by the provider**. So a scenario is a switch plus a template name — not a box you
type a message into. Turning a scenario on without a template is refused, and so
is a WhatsApp broadcast without one.

Placeholders are filled positionally: `templateVariables` is an ordered list, and
position *n* fills `{{n}}`. Every event provides `recipientName`, `title` and `body`.

### Delivery

| Setting | Meaning |
| ------- | ------- |
| `WHATSAPP_DRIVER=log` | Default. Records every message in the outbox without sending — the whole flow works with no account and no cost |
| `WHATSAPP_DRIVER=meta` | Sends through the WhatsApp Cloud API. Needs `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN` |

**Messaging → Scenarios** shows a "Not sending" banner whenever messages are
being recorded rather than delivered, and says why.

The destination is the employee's mobile number, falling back to the user's
phone. Numbers are normalised to E.164 digits; `WHATSAPP_DEFAULT_COUNTRY_CODE`
(default `91`) is prefixed to a local number. A recipient with no usable number
is logged as `SKIPPED` with the reason rather than failing silently.

Delivery hangs off `notifyUser`, which every notification path funnels through,
so all 13 events are covered without touching the code that raises them. A
failed send never propagates: not telling someone about a payroll run must not
roll the payroll run back.

---

## Proof of payment

Cash and offline transfers have no bank record to point at, so a payment carries:

- **Transaction ID** — the existing `reference_number`, unique per organization
  across non-reversed payments. A UTR, UPI reference or cheque number; for cash,
  a voucher or receipt number.
- **Proof document** — optional PDF, PNG or JPEG up to 10 MB, attached from the
  payroll item screen after the payment is recorded.

The proof is uploaded as a second request, so a storage failure cannot lose the
payment itself — the payment is kept and the upload error reported separately.
Like every other upload the real type is read from the file's bytes, it never
gets a public URL, and it is streamed back only after a permission check. A
reversed payment will not accept new proof.

---

## Behaviour that looks like a bug but isn't

- **Deleting a department, section or location is refused** while employees are
  assigned. Set it inactive instead — it leaves the pickers, history stays intact.
- **A locked payroll run never changes.** Corrections are raised as adjustments
  (correction, reversal, arrear, recovery).
- **A weekly off is not paid.** It counts towards the calendar days payroll divides by,
  but earns nothing, so pay follows the days actually worked. Holidays *are* paid.
- **A leave can charge a day outside the dates applied for.** That is the sandwich rule
  on holidays; see Leave above.
- **Aadhaar, PAN and bank numbers render masked** unless the viewer holds
  `sensitive.view`; unmasking is itself audited.
- **Documents are never public URLs** — fetched with a bearer token after a
  permission check, never a plain `<img src>` or link.
- **Sessions are short-lived by design.** The access token is in memory only; the
  refresh token is an httpOnly cookie. A reload restores the session by refreshing.

---

## Known gaps

- **Shifts** — complete API (`/shifts`, full CRUD) with no interface anywhere.

The Super Admin "My" section issue is fixed: the sidebar gates that group on having
an employee record rather than on holding the `.self` permissions, so an
administrative account no longer sees six links that error.

---

## The in-app tour

New users get a guided walkthrough on their first sign-in: a spotlight moves down
the sidebar, one module at a time, saying what each is for. It can be replayed any
time from the account menu → **Take the tour**.

Steps live in `src/app/tour/tour-steps.ts` as one superset. At runtime the tour keeps
only the steps whose target is actually on screen — and because the sidebar is built
from the signed-in user's permissions, each role gets the right walkthrough without a
separate script:

| Role | Steps | Covers |
| ---- | ----- | ------ |
| Super Admin | 22 | Every module, config through payroll and audit. No "My" section — they have no employee record |
| Supervisor | 19 | Team employees, documents, attendance, leave, reports, plus their own records |
| Employee | 14 | Dashboard, calendar, and their own profile, attendance, leave, salary, payslips, documents |

Seen-state is per user in `localStorage` (`northstar.tour.v1.<userId>`). Clear that key
to see the first-run tour again.

---

## Development accounts

`npm run server:seed` creates an **empty workspace** — one organization and two
Super Admin logins, and nothing else. No sample employees, departments, salary
structures or payroll.

| Role | Email |
| ---- | ----- |
| Super Admin | `admin@northstar.example` |
| Super Admin | `admin1@northstar.example` |

Both use `SEED_DEFAULT_PASSWORD` (`Passw0rd!123` by default). Neither has an
employee record, so neither sees the "My" section.

Re-running the seed **clears the workspace**: it deletes every employee, user
other than these two, and all configuration and payroll for the organization.
It refuses to run when `NODE_ENV=production`. Set the workspace up from
Organization, then Salary, Calendar and Employees — see **Setup order** above.
