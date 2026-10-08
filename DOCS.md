# SKTRANSPORT — quick reference

Minimal operating notes. `README.md` covers installation and the codebase layout;
this file covers what the application *does*, in the order you use it.

---

## Roles

| Role | Scope | Notes |
| ---- | ----- | ----- |
| `SUPER_ADMIN` | Everything (all 93 permissions) | Administrative account, **not** an employee — no attendance, leave, salary or payslips of their own |
| `MANAGER` | Their supervisors, and everyone on those supervisors' teams | Same team permissions as a supervisor, one level up; also sees their supervisors on **Supervisors** |
| `SUPERVISOR` | Their assigned team | Team salary, team payroll and team reports are **not** granted by default — grant per user from Users |
| `EMPLOYEE` | Themselves only | — |

The role is only a starting set. Any single permission can be granted or revoked
per user from **Users**, which is how "this one supervisor may see team salary"
is expressed without adding another role. The sidebar builds itself from the
signed-in user's permissions.

**Managers.** A manager is an employee with *Is a manager* ticked, signing in
with the `MANAGER` role. The Super Admin assigns supervisors to them from
**People → Managers → Assign supervisors** (or the *Manager* field on a
supervisor's employee form). A supervisor has at most one manager. Anyone a
manager's supervisors look after — and anyone who reports to the manager
directly — is in the manager's team for attendance, leave, documents, overtime
and reports. Removing *Is a manager*, or deleting the employee, is refused while
supervisors are still assigned to them.

**App lock PIN.** Super Admins, managers and supervisors can turn on a 4-digit
PIN under **Settings → App lock PIN** (their password is asked for to set,
change or remove it). With it on, every time the site is opened on a device
where they are still signed in — a new tab, a reload, the browser reopened — it
shows a PIN screen before anything else. Signing in with the password never asks
for the PIN, and an open page is not interrupted while it is being used.
**Lock now** in the account menu locks the current page on demand. Five wrong
PINs in a row sign that device out, and the password is needed. The lock is
enforced by the API, not just the screen: until the PIN is entered, every
request except the unlock itself is refused with `423 APP_LOCKED`. The
permission is `applock.manage`; grant it to an individual employee from Users
if they need it too.

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
7. **Salary → PF, ESI & policy** — statutory rates and how paid days are counted. PF and
   ESI rates, the PF wage ceiling, the EPS share and the ESI wage limit are kept per
   structure as dated periods: each applies from its date until the next one starts (the
   first has no start date and covers everything before). To change a rate from a date,
   open the structure's **Rates** and *Add rate change*. When a change falls inside a
   payroll cycle, PF is split at it: the wages earned before the change are capped at the
   old ceiling, those from it at the new one, each part is charged its own rate, and the
   total is rounded once (e.g. 15,600 to 16 Sep capped at 15,000, plus 1,950 from 17 Sep =
   a PF wage of 16,950). ESI uses the period in force on the run's last day, on the whole
   month's wage. Approved runs keep the rates they were calculated with.
8. **Employees → Add employee** — optionally creating a login at the same time.
9. **Salary → Assign salary** — until this exists, payroll produces no line for that employee.
   Tick any number of employees (filter by department or current structure, or select
   everyone shown), choose the structure and the date it starts, then confirm. Any date
   works: on the date an employee's assignment already starts, that assignment is changed;
   inside an assignment, it ends the day before and the new one takes over; otherwise the
   new one runs until the employee's next change. The confirmation lists what changes for
   each employee and which payroll runs need calculating again.

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
  **Calendar** (Attendance → *Calendar* tab): a calendar **month** or a **week**, filtered by
  department, supervisor or one employee. A summary strip gives the period's attendance rate
  (days worked, half days counting half, out of days people were expected to work) and totals.
  For a team each day shows its rate, a bar of the split and how many were present, absent, on
  half day, on leave, on holiday or weekly off, and not marked; clicking a day lists the
  employees (ID and name) under each status. For one employee each day is a coloured circle,
  and anyone who can mark attendance (Super Admin, manager, supervisor) can click a day to
  change it — with a leave type for leave or half day, and an optional note kept in the day's
  history. Days in a locked payroll run cannot be changed; a day set by an approved leave
  request can, but the request itself is left as it is. A day without a record shows what the
  company calendar says it is (holiday or weekly off), as *My attendance* does; "not marked"
  is never shown for future days. An absence alert's link opens the calendar on that employee.
  Endpoint: `GET /attendance/calendar?from&to` (at most 42 days).
- **Leave** — employee applies → supervisor or admin approves/rejects → an approved
  request writes back into attendance. Statuses: `PENDING` `APPROVED` `REJECTED` `CANCELLED`.
  **Sandwich rule** (`sandwichHolidays`, on by default): a holiday with a full day of
  leave immediately before it *and* immediately after it is charged as leave too. The
  leave either side may belong to a different request, so a charged holiday can fall
  outside the dates the employee asked for — a Friday request and a Monday request with
  a holiday on the Saturday between them costs three days, not two. An unbroken run of
  holidays counts as one sandwich; a weekly off between the leave and the holiday breaks
  the run and nothing is charged. A **half day** next to a holiday counts as leave for
  this rule: a half day before the holiday and a full day of leave after it (or the
  other way round) charges the holiday too.
  Payroll applies the same rule to unpaid days: a holiday not worked, with an absence,
  unpaid leave or a half day on each side, is not paid. A holiday **worked for half a
  day** is never charged or forfeited; it pays that half day, and if the holiday has
  *extra pay* on, half a day of holiday work pay on top — two half days in all.
- **Holiday pay** — a holiday the employee rests on is paid, unless the sandwich rule above
  forfeits it, but **without** the salary components whose *Include in holiday pay* is
  unticked (SKT's Special Allowance). A holiday **worked** is paid as a day worked, with
  every component, plus — on a holiday with *extra pay* on — one more day of holiday work
  pay, again without those components.
- **Bonuses** and **PL Wages** — paid separately from salary, never through payroll.
  An approved one is marked paid once it has actually been paid: the date, how it was
  paid (bank transfer, cash, cheque, UPI), a reference and a supporting document
  (PDF, PNG or JPEG). Many can be marked paid at once with one shared document, and a
  paid one can be marked not paid again, which removes its details and document.
- **Overtime** — paid hourly overtime is added straight to net pay, like Other
  Credits: it is not part of gross earnings, so no PF, ESI or other deduction is taken
  from it. Net salary = gross earnings − total deductions + overtime + other credits.
- **Paid offs** — a Supply employee's overtime is never money: every 8 hours in a week
  (Monday–Sunday) earns one paid off, up to 2 a week; hours short of 8 do not carry
  into the next week. An administrator, manager or supervisor gives each one a date
  under Overtime → Paid offs: one of the employee's working days, with no attendance
  marked yet, in a payroll month not yet approved (a supervisor or manager for their
  team, never themselves). That day becomes the employee's off and payroll pays it as
  a day worked, every component included, shown as `Paid offs` on the payslip.
  Removing one puts it back in the balance, until its payroll is approved; overtime
  cannot be reduced below the paid offs already scheduled from it.
- **Tax** — the tax amount for each band of wages (Tax → Tax slabs). The tax report
  applies the bands to each employee's *total wages over a period* (usually a
  half-year) and exports the P.TAX workbook, a sheet per department. From the
  report an administrator chooses the payroll month the tax comes out of pay
  ("Deduct from salary"); payroll then deducts it as a `P.Tax` line when it
  calculates that month. Repeating it for the same month replaces it, until that
  payroll is approved. There is no deductions module; PF, ESI and P.Tax are the
  payroll deductions besides salary-structure components and adjustments.
- **P.Tax on exit** — saving an employee as *Resigned* or *Terminated* with an exit
  date asks whether to deduct the half-year's P.Tax from their final salary: the
  payroll month whose dates hold the exit date (the standard 21st–20th cycle when
  no run exists yet). Payroll works the amount out when it calculates that month —
  the slab for the half-year's wages so far, that month's included — and shows it
  as `P.Tax (on exit)`, beside any tax set from the report for the half-year that
  just ended. Until then the deduction shows an estimate from the months already
  calculated. Moving or clearing the exit date withdraws it (unless that payroll is
  approved), and "Deduct from salary" on the tax report leaves out a leaver whose
  tax for the period already came out on exit.
- **Leavers' logins** — an employee can sign in up to and including their exit date.
  From midnight (India time) after it, sign-in, staying signed in and every request
  are refused, and within the hour their login is marked inactive on the Users page.
  Only the login changes: the employee is still paid their final salary. To let them
  back in, clear or change the exit date first, then activate the login.

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
| Remove an Other Deduction / Other Credit (or any adjustment) | no run yet, `DRAFT`, `CALCULATED`, `UNDER_REVIEW` | its month's run is `APPROVED` or `LOCKED` |

Removing one that a calculation already put on a payslip sends that month's run back to
`DRAFT`, as changing its dates does: it must be calculated again before it can be approved.

Payment status is separate from run status: `PENDING` → `PARTIALLY_PAID` → `PAID`.
A run can be locked while money is still going out. Employees see their payslip
once the run reaches `APPROVED`.

**What the calculator reads** — the employee's salary structure and components,
every day of the month resolved against the calendar, whether each leave day was
paid, the overtime recorded, the tax and Labour Welfare Fund set to be deducted, Other
Deductions and Other Credits, and the PF and ESI rules on the salary structure. Bonuses
and PL Wages are not part of it.

**Salary reports** — the Salary Register, Payment Status and Department Salary reports
split each net salary into gross earnings, PF, ESI, P.Tax, LWF, other deductions, total
deductions, overtime and other credits, each with its own total, so gross − deductions +
overtime + other credits = net can be checked on every row and in the totals. For a month
calculated before overtime moved out of gross, its overtime is taken back out of gross in
these reports and shown under Overtime, so those months add up the same way.
The Salary Register also shows, for each employee in the run:
- **Working Days** — every day worked, a holiday worked included (a half day is 0.5).
- **Eligible Holidays** — the holidays that earn holiday pay: each one rested on and not
  forfeited by the sandwich rule, and each one worked on a holiday with *extra pay* on.
- **Holiday Wages** — that holiday pay, without the components left out of holiday pay
  (Special Allowance). For a holiday worked it is the holiday work pay, on top of the day's
  work counted in Working Days.

A worked holiday counts as both a working day and an eligible holiday, because it is paid
as both. For a daily-rated employee, gross is the working days at the full day rate plus the
holiday wages (plus any paid leave). All of it is already inside gross earnings.

**EPS and EPF** — the employer's PF share is split into the Pension Scheme (EPS, the
structure's EPS rate, usually 8.33%) and EPF (the rest). For an employee whose PF
details say **Pension applicable: No**, there is no EPS: the whole employer share
goes to EPF (for example 1,800 on a 15,000 PF wage), and the ECR file shows EPS
wages of 0 for them.

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
- **The site asks for a PIN although you are signed in.** That is the app lock
  (see Roles above); it asks each time the site is opened, not on every page.
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
| Super Admin | 23 | Every module, config through payroll and audit. No "My" section — they have no employee record |
| Manager | 20 | As a supervisor, plus their supervisors |
| Supervisor | 19 | Team employees, documents, attendance, leave, reports, plus their own records |
| Employee | 14 | Dashboard, calendar, and their own profile, attendance, leave, salary, payslips, documents |

Seen-state is per user in `localStorage` (`sktransport.tour.v1.<userId>`). Clear that key
to see the first-run tour again.

---

## Development accounts

`npm run server:seed` creates an **empty workspace** — one organization and two
Super Admin logins, and nothing else. No sample employees, departments, salary
structures or payroll.

| Role | Email |
| ---- | ----- |
| Super Admin | `admin@skt.com` |
| Super Admin | `admin1@skt.com` |

Both use `SEED_DEFAULT_PASSWORD` (`Passw0rd!123` by default). Neither has an
employee record, so neither sees the "My" section.

Re-running the seed **clears the workspace**: it deletes every employee, user
other than these two, and all configuration and payroll for the organization.
It refuses to run when `NODE_ENV=production`. Set the workspace up from
Organization, then Salary, Calendar and Employees — see **Setup order** above.
