# SKTRANSPORT — Employee Management & Payroll

A production-shaped Employee Management, Attendance, Leave, Salary, Payroll and
Reporting system, built as a React PWA on an Express API and PostgreSQL.

- **Frontend** — React + TypeScript + Vite, React Router, TanStack Query,
  React Hook Form + Zod, installable PWA with an offline app shell.
- **Backend** — Node + Express + TypeScript, REST under `/api/v1`, Zod
  validation, JWT access tokens with rotating httpOnly refresh cookies,
  permission-based RBAC, structured logging with sensitive-field redaction.
- **Database** — PostgreSQL with SQL migrations, UUID keys, and transactions
  around every financial operation.

---

## Quick start

You need Node 22+ and a running PostgreSQL 14 or newer.

```bash
# 1. Install both workspaces
npm run setup

# 2. Configure the API
cp server/.env.example server/.env
#    then set DATABASE_URL to your database, and generate the two secrets:
#    node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 3. Create the schema and load development data
npm run server:migrate
npm run server:seed

# 4. Run both sides
npm run server:dev      # API on http://localhost:4000
npm run dev             # Web on http://localhost:5173
```

### Creating the database

If you do not already have one, from a superuser psql session:

```sql
CREATE ROLE payroll LOGIN PASSWORD 'choose-a-password';
CREATE DATABASE payroll OWNER payroll;
```

The migrations create three extensions (`pgcrypto`, `pg_trgm`, `btree_gist`).
Creating an extension needs superuser rights on most installations, so either
run the migrations as a superuser once, or pre-create the extensions in the
database and let the application role own only the tables.

Then point `DATABASE_URL` at it:

```
DATABASE_URL=postgres://payroll:choose-a-password@localhost:5432/payroll
```

In development Vite proxies `/api` to the API, so the browser talks to a single
origin and the refresh cookie works without CORS exceptions.

### Development accounts

The seed creates one organization with a full month of attendance, a calculated
and approved payroll run, and sample payments. Every account shares the password
in `SEED_DEFAULT_PASSWORD` (`Passw0rd!123` by default):

| Role        | Email                            |
| ----------- | -------------------------------- |
| Super Admin | `admin@skt.com`        |
| Supervisor  | `ravi.kulkarni@skt.com` |
| Supervisor  | `fatima.sheikh@skt.com` |
| Employee    | `john.doe@skt.com`     |

Signing in as each shows the three different dashboards, menus and permissions.
The seed refuses to run when `NODE_ENV=production`.

---

For what the application *does* — roles, setup order, the monthly payroll cycle and
its status transitions — see [DOCS.md](DOCS.md).

---

## Branding

The app takes its identity from the organization record rather than from
constants, so a Super Admin rebrands it from **Organization -> Branding** with
no deploy:

| What        | Where it comes from                    | Applied to                                        |
| ----------- | -------------------------------------- | ------------------------------------------------- |
| Name        | `organizations.name` (Profile tab)     | sidebar, browser tab title                        |
| Logo        | `organizations.logo_path`              | sidebar; falls back to the name's initials        |
| Accent      | `organizations.theme_color`            | the whole `--brand-*` ramp, and dashboard charts  |

The accent is stored as one hex value. `BrandingProvider` derives the six
`--brand-*` stops from it and sets them on the root element, which is why no
component needs to know more than one colour - and why the defaults in
`src/styles.css` (indigo, `#5b54d6`) are the only place a brand colour is
hard-coded.

Logos are PNG or JPEG up to 2 MB. Like employee documents they are never served
from a public URL: the bytes are sniffed on upload, stored through the same
object-storage driver, and streamed back only after a permission check, so the
client fetches the image with its bearer token rather than an `<img src>`.

The sign-in screen is deliberately *not* branded - there is no authenticated
organization context before sign-in, and serving the name and logo publicly
would leak them to anyone who can reach the page.

---

## Commands

| Command                  | What it does                                     |
| ------------------------ | ------------------------------------------------ |
| `npm run dev`            | Vite dev server                                  |
| `npm run build`          | Typecheck and build the PWA                      |
| `npm run server:dev`     | API with hot reload                              |
| `npm run server:migrate` | Apply pending migrations                         |
| `npm run server:seed`    | Load development data                            |
| `npm run server:test`    | Payroll calculation test suite                   |
| `npm run server:smoke`   | Boot the API and check routing without a database |
| `npm run check`          | Typecheck both sides and run the tests           |
| `npm run icons`          | Regenerate the PWA icons                         |

---

## How it is put together

```
.
├── src/                    React PWA
│   ├── app/                router, providers, navigation model
│   ├── features/           one folder per domain area
│   ├── components/         ui kit, data table, form controls
│   ├── layouts/            application shell
│   ├── lib/                api client, formatting, PWA registration
│   └── types/              shared API types
├── server/src/
│   ├── config/             validated environment
│   ├── database/           pool, transactions, migrations, seed
│   ├── middleware/         auth, authorization, validation, errors, uploads
│   ├── modules/            one folder per domain module
│   └── utils/              money, dates, masking, files, pagination
├── public/                 manifest, service worker, icons
└── nginx.conf              optional single-origin reverse proxy
```

Each backend module holds its own `validation`, `repository`, `service`,
`controller` and `routes`, so business rules live in services and SQL stays in
repositories.

---

## The parts worth knowing

### Attendance is status-based

Attendance records a status per employee per date and nothing else. There is
deliberately no check-in, check-out, break, GPS, biometric, working-hours or
overtime handling. `UNIQUE (employee_id, attendance_date)` enforces one record
per employee per day, and the table is shaped so time-based attendance can be
added later as nullable columns.

Statuses: `PRESENT`, `ABSENT`, `ON_LEAVE`, `HALF_DAY_LEAVE`, `HOLIDAY`,
`WEEKLY_OFF`.

### Weekly offs and holidays are configuration

Saturday and Sunday are never assumed. A weekly off rule names its weekdays and,
optionally, which occurrences apply — so "every Sunday", "2nd and 4th Saturday"
and "1st, 3rd and 5th Saturday" are all expressible. Rules can be scoped to a
department or location; the most specific active rule wins.

`calendar.service.ts` resolves a date range once and answers "what kind of day is
this for this employee?" for attendance, the monthly calendar and payroll alike.

### Payroll is a pure, deterministic function

`payroll.calculator.ts` takes a fully materialised snapshot of one employee's
month and returns the figures. It touches no database and no clock, so the same
input always produces the same output — which is what makes payroll reproducible
and testable. `payroll.service.ts` loads the inputs in batch queries, runs the
calculator, and writes the snapshot inside one transaction.

Money crosses that boundary as integer paise, so rounding is explicit and totals
always reconcile.

The lifecycle is `DRAFT → CALCULATED → UNDER_REVIEW → APPROVED → LOCKED`.
Recalculating is safe until the run is approved. Locking freezes the attendance
the run consumed; corrections after that go through a payroll adjustment applied
in a later month, never an edit to history.

Payment status is tracked separately from run status, driven by immutable
transaction rows: an employee can be paid in instalments, the total can never
exceed net salary, and a reversal is recorded rather than deleted.

### Nothing statutory is hard-coded

PF, ESI and professional tax rates, ceilings and eligibility limits are rows in
`statutory_configs`, effective-dated. How paid days are derived (calendar days,
working days or actual attendance days) and what a half day is worth live in
`payroll_policies`. Whether a leave type is paid is a property of the leave type.
Payroll reads whichever rule was in force for the month it is calculating.

### Authorization is permission-based

Roles (`SUPER_ADMIN`, `SUPERVISOR`, `EMPLOYEE`) carry a default permission set,
and individual users can be granted or denied permissions on top. That is how
"supervisor may view team salary only if explicitly permitted" works without
inventing a role.

Every list endpoint folds an employee scope (`ALL` / `TEAM` / `SELF`) into its
WHERE clause, and every by-id endpoint asserts the target falls inside it. An
employee calling `GET /employees` receives only themselves.

### Sensitive data

Aadhaar, PAN and bank account numbers are masked in every list and profile
response. Revealing one is a separate request that requires an explicit
permission and is written to the audit log. Documents and payslips are never
public URLs: they are streamed only after a permission check, stored under
generated keys, and the real content type is sniffed from the file's magic bytes
rather than trusted from the client. Sensitive fields are redacted from both the
application log and the audit trail.

---

## Testing

```bash
npm run server:test
```

The payroll suite covers the cases that decide whether payroll is right: monthly
and daily employees, present and absent days, paid and unpaid leave, half days,
holidays, weekly offs, bonuses, PF with a wage ceiling, ESI with an eligibility
limit, mid-month joiners and leavers, the worked example from the specification, and
byte-identical output for identical input.

---

## Deployment

```bash
# Build both sides
npm run build            # frontend -> dist/
npm --prefix server run build   # API -> server/dist/

# Run the API (it applies pending migrations on startup)
NODE_ENV=production node server/dist/server.js
```

Serve `dist/` as static files and put the API behind the same origin so the
httpOnly refresh cookie stays same-site. `nginx.conf` is a working example of
that arrangement; adjust `root` to point at your `dist/` directory. Terminate
TLS in front of it before exposing it publicly.

The API applies its own migrations on startup, so a deploy is: build, restart.

Documents and payslips are written to `STORAGE_LOCAL_DIR` (`server/storage` by
default) - back that directory up alongside the database. Set
`STORAGE_DRIVER=s3` with the `STORAGE_*` variables to move them to object
storage instead.

---
## Designed to extend

The schema and module boundaries leave room for check-in/check-out, biometric and
GPS attendance, overtime, loans, reimbursements, TDS, multiple organizations and
multiple locations without rewriting what is here. Shift records already carry
times; `organization_id` is on every tenant-scoped table; and the payroll
calculator's input is a plain data structure, so a new earning or deduction is a
new component rather than a new code path.
