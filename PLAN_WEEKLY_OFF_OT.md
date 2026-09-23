# Plan: Per-Employee Weekly Off, Employee Type/Plant, and Overtime

Status: proposal — not yet implemented. Covers four related changes requested against
the current codebase:

1. Replace the department/location-only weekly-off rule engine with a calendar UI that
   lets Admin (all employees) and Supervisor (their team) assign specific employees a
   weekly off, which then keeps applying to future weeks until reconfigured.
2. Employee form: turn Location into its own form section, and add `Employee type`
   (Supply / PSR) and `Plant` (Ultratech / ICL).
3. Overtime: Supply employees convert every 8 OT hours into one extra weekly off (max 2
   in the same week, from 16 hours); PSR employees get OT paid in salary at a
   configurable per-hour rate.
4. Global payroll-cycle change: every month-based calculation (attendance, weekly off,
   OT, payroll) runs 21st→20th instead of 1st→end-of-month, with the 21st–end-of-month
   tail belonging to the next month's cycle.

This plan builds directly on the existing architecture (Express + PostgreSQL modules,
Zod validation, permission-based RBAC, the pure payroll calculator) rather than
introducing new patterns. Every file reference below is to the current code.

---

## 0. Current state (for context)

- **Weekly off today** is a department/location-scoped *rule* (`weekly_off_rules` +
  `weekly_off_rule_days`, [server/src/database/migrations/0004_calendar_shifts.sql](server/src/database/migrations/0004_calendar_shifts.sql)),
  resolved by [calendar.service.ts](server/src/modules/calendar/calendar.service.ts) using
  "most specific active rule wins" (department+location > department > org-wide). There is
  **no per-employee assignment and no calendar-grid UI** — only a list-and-modal admin
  screen ([CalendarPage.tsx](src/features/calendar/CalendarPage.tsx)).
- **Employees** ([0002_org_structure_employees.sql](server/src/database/migrations/0002_org_structure_employees.sql))
  have `location_id` (a real FK to `locations`), `supervisor_id` (self-referencing FK, one
  supervisor per employee), and `salary_basis` (`MONTHLY`/`DAILY`) — but **no `employee_type`
  or `plant` field**.
- **Overtime does not exist anywhere.** `attendance.validation.ts` explicitly notes it is
  out of scope today. Attendance is status-only, one record per employee per day
  ([0005_attendance.sql](server/src/database/migrations/0005_attendance.sql)).
- **Payroll periods are calendar months** (1st to last day), computed in
  [payroll.service.ts](server/src/modules/payroll/payroll.service.ts) via
  `firstDayOfMonth`/`lastDayOfMonth` ([dates.ts](server/src/utils/dates.ts)). No 20th-cutoff
  logic exists.
- **RBAC**: permission catalogue in [permissions.ts](server/src/modules/auth/permissions.ts);
  scope resolution (`ALL`/`TEAM`/`SELF`) via
  [employee-access.ts](server/src/modules/employees/employee-access.ts), already used
  identically by attendance (`ATTENDANCE_MANAGE_ALL`/`_TEAM`) — this is the pattern every
  new permission below follows.
- **Payroll calculator** ([payroll.calculator.ts](server/src/modules/payroll/payroll.calculator.ts))
  is a pure function; bonuses become extra `EARNING` components
  ([payroll.calculator.ts:627-648](server/src/modules/payroll/payroll.calculator.ts#L627-L648)) — the
  template OT-as-salary will follow.

---

## 1. Open questions to confirm before/during build

These are genuine judgment calls the ticket doesn't specify. Default assumptions are
stated so work isn't blocked, but confirm before Phase 3 locks in:

| # | Question | Assumption used below |
|---|---|---|
| 1 | Supply OT that isn't a multiple of 8 (e.g. 10 hrs) — carry remainder to next week, forfeit, or pay? | Forfeit remainder; only whole 8-hour blocks convert. Flag as a warning on the OT entry, don't silently drop. |
| 2 | Supply OT beyond 16 hrs/week (cap is 2 offs) — forfeit, carry over, or pay as PSR-style OT? | Hard cap at 2 extra offs/week; hours beyond that are recorded but produce no further conversion (surfaced as a warning). |
| 3 | Does OT need a supervisor/admin **approval** step, or does entering it take effect immediately (like attendance, which has no approval step)? | No separate approval step — entering an OT record is the authoritative action, mirroring how attendance itself works today. Can be layered in later without a schema change (add a `status` column). |
| 4 | Is "week" Mon–Sun, or does it follow the weekly-off weekday configuration? | ISO week, Monday–Sunday, independent of the 21st–20th payroll cycle (the cycle affects month labeling only, not weekly OT bucketing). |
| 5 | Is `plant` a fixed 2-value list forever, or will more plants be added? | Modeled as a Postgres enum (`ULTRATECH`, `ICL`), consistent with how `gender`/`employment_type`/`marital_status` are already enums in this codebase. If more plants are likely, prefer a lookup table like `locations` instead — flag this before migration 0011 is written. |
| 6 | Should the per-employee weekly-off calendar **replace** the department/location rules entirely, or sit on top as an override? | Sits on top, as the most-specific override. Removing the rule engine would regress every employee who currently relies on an org/department-wide rule and has no personal override yet. |

---

## 2. Phase 0 — Payroll cycle: 21st → 20th (foundational)

Do this first: weekly-off "next weeks", monthly attendance views, and OT monthly
crediting all read whatever month-boundary logic exists, so getting this right early
avoids rework.

### 2.1 Model

Add cycle-aware date helpers to [dates.ts](server/src/utils/dates.ts), alongside the
existing `firstDayOfMonth`/`lastDayOfMonth`:

```ts
// cutoffDay = the last day of the cycle within the "ending" month (20 here).
// Cycle for (year, month) = [cutoffDay+1 of (month-1), cutoffDay of month].
export function payCycleFor(year: number, month: number, cutoffDay: number | null): { start: IsoDate; end: IsoDate }
// Resolves which (year, month) label a given date belongs to under the cutoff.
export function payCycleContaining(date: IsoDate, cutoffDay: number | null): { year: number; month: number; start: IsoDate; end: IsoDate }
```

`cutoffDay: null` reproduces today's calendar-month behavior exactly (`firstDayOfMonth`/
`lastDayOfMonth`) — this keeps the change backward compatible for any org that doesn't
opt in. Handle month lengths correctly (e.g. cutoff 20 in a 28-day February still cleanly
produces Jan 21–Feb 20).

### 2.2 Configuration

Add a nullable column to `payroll_policies` ([0007_salary_bonus_deductions.sql](server/src/database/migrations/0007_salary_bonus_deductions.sql)):

```sql
ALTER TABLE payroll_policies ADD COLUMN cycle_cutoff_day SMALLINT
  CHECK (cycle_cutoff_day IS NULL OR cycle_cutoff_day BETWEEN 1 AND 28);
```

(Capped at 28 so the cutoff always exists in every month.) Set it to `20` for this
organization's policy row as part of the migration's data step, or via the Settings UI —
confirm which with the user before writing the migration's `UPDATE`.

### 2.3 Where it plugs in

- [payroll.service.ts:218-219](server/src/modules/payroll/payroll.service.ts#L218-L219) —
  replace `firstDayOfMonth(input.year, input.month)` / `lastDayOfMonth(...)` with
  `payCycleFor(input.year, input.month, policy.cycleCutoffDay)`. `payroll_runs.year/month`
  keeps labeling the *ending* month of the cycle — no schema change needed there, only a
  comment update.
- [attendance.service.ts `getMonthlyCalendar`](server/src/modules/attendance/attendance.service.ts#L164-L260) —
  same swap, so "September" in the attendance grid shows the identical Aug 21–Sep 20 window
  payroll will use. These two **must never drift apart**, or paid-days math silently breaks.
- The new OT monthly summary (Phase 3) uses the same helper for its "this month's OT" report.
- Frontend month pickers (`PayrollRunPage`, `MonthlyCalendarView`) should display the
  resolved range next to the month label (e.g. "September (21 Aug – 20 Sep)") so the cutoff
  isn't invisible to users — small addition, read from a client-side port of `payCycleFor`
  or a `GET /payroll/cycle?year&month` endpoint.

### 2.4 Not affected

Weekly-off weekday bucketing (Phase 2) and OT weekly bucketing (Phase 3) stay ISO
Monday–Sunday — the cutoff only changes which *month* a date's attendance/payroll/OT
summary counts against, never which *week*.

---

## 3. Phase 1 — Employee: Location section, Employee type, Plant

### 3.1 Schema — new migration `0011_employee_type_plant.sql`

```sql
CREATE TYPE employee_type AS ENUM ('SUPPLY', 'PSR');
CREATE TYPE plant_type AS ENUM ('ULTRATECH', 'ICL');

ALTER TABLE employees
  ADD COLUMN employee_type employee_type NOT NULL DEFAULT 'SUPPLY',
  ADD COLUMN plant plant_type;

-- Existing rows need a real value before this can be made required; either backfill here
-- from another signal (department/location) or leave nullable until an admin sweep — confirm
-- with the user which, since neither is derivable from current data.

ALTER TYPE job_change_type ADD VALUE 'EMPLOYEE_TYPE_CHANGE';
ALTER TYPE job_change_type ADD VALUE 'PLANT_CHANGE';
ALTER TABLE employee_job_history
  ADD COLUMN employee_type employee_type,
  ADD COLUMN plant plant_type;
```

`employee_type` defaults to `SUPPLY` for existing rows purely so the column can be
`NOT NULL` (it feeds OT branching in Phase 3, so it can't silently be null); `plant` is
left nullable since there's no safe default — surface "Plant not set" in the UI as a
to-do for admins rather than guessing.

### 3.2 Backend

- [employees.validation.ts](server/src/modules/employees/employees.validation.ts):
  add `employeeTypeSchema = z.enum(['SUPPLY', 'PSR'])` and `plantSchema = z.enum(['ULTRATECH', 'ICL'])`;
  add both fields to `createEmployeeSchema` (`employeeType` required with `.default('SUPPLY')`,
  `plant` optional), `updateEmployeeSchema` (both optional), and
  `employeeListQuerySchema` (filterable, matching how `locationId`/`salaryBasis` are already
  filterable at [employees.validation.ts:141-156](server/src/modules/employees/employees.validation.ts#L141-L156)).
- `employees.repository.ts` / `employees.service.ts` (not shown above, but same shape as every
  other employee column): add to the `SELECT`, `INSERT`, `UPDATE` column lists, and to the
  job-history writer so a type/plant change is logged like `LOCATION_CHANGE` is today.
- No new permissions needed — these fields ride on the existing `EMPLOYEE_CREATE`/`EMPLOYEE_UPDATE`.

### 3.3 Frontend — Employee form

Restructure the employee create/edit form (wherever `location_id` is currently a bare
field — the form isn't in the excerpts read for this plan, so locate it via
`grep -r "locationId" src/features/employees` before editing) into an explicit section,
e.g.:

```
Section: "Location & Employment Type"
  - Location            (existing LocationSelector-style dropdown, if one exists;
                          otherwise build one mirroring DepartmentSelector, see
                          src/components/forms/selectors.tsx)
  - Employee type        Select: Supply / PSR
  - Plant                 Select: Ultratech / ICL
```

Use the same `Field` + `Select` primitives already used throughout
[CalendarPage.tsx](src/features/calendar/CalendarPage.tsx) and the org's other forms, so
this doesn't introduce a new form pattern. Add `employeeType`/`plant` columns to the
employee list/detail views and to `employeeListQuerySchema`-backed filters.

---

## 4. Phase 2 — Per-employee weekly off via calendar

### 4.1 Model

Two new tables. Keep the existing `weekly_off_rules` engine as the fallback layer — new
per-employee data only *overrides* it, per open question 6.

**`employee_weekly_off_assignments`** — the recurring per-employee weekday, set via the
calendar UI, applies to "upcoming not-configured weeks" until superseded:

```sql
CREATE TABLE employee_weekly_off_assignments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  weekday           weekday_name NOT NULL,   -- reuse the enum from 0004_calendar_shifts.sql
  effective_from    DATE NOT NULL,           -- Monday of the first week this applies to
  effective_to      DATE,                    -- NULL = open-ended ("upcoming not configured weeks")
  created_by        UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_weekly_off_assignments_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- One open (or overlapping-dated) recurring assignment per employee at a time, same
-- pattern as employee_salary_assignments' GiST exclusion (0007_salary_bonus_deductions.sql:120-125).
CREATE EXTENSION IF NOT EXISTS btree_gist; -- already enabled by an earlier migration
ALTER TABLE employee_weekly_off_assignments
  ADD CONSTRAINT employee_weekly_off_assignments_no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'), '[]') WITH &&
  );

CREATE INDEX employee_weekly_off_assignments_employee_id_idx ON employee_weekly_off_assignments (employee_id);
```

**`employee_extra_weekly_offs`** — one-off, specific-date grants (used both for a manual
one-time override from the calendar and for OT-converted extra offs in Phase 3):

```sql
CREATE TABLE employee_extra_weekly_offs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id        UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  off_date           DATE NOT NULL,
  source             TEXT NOT NULL DEFAULT 'ADMIN_ASSIGNED', -- ADMIN_ASSIGNED | OVERTIME_CONVERSION
  overtime_entry_id  UUID,  -- FK added in Phase 3's migration once overtime_entries exists
  granted_by         UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_extra_weekly_offs_unique UNIQUE (employee_id, off_date)
);
```

Both tables live in a new migration `0012_employee_weekly_off_assignments.sql`.

### 4.2 Resolution order (calendar.service.ts)

Extend `EmployeeCalendarScope` ([calendar.service.ts:33-36](server/src/modules/calendar/calendar.service.ts#L33-L36))
to carry `employeeId`, and change resolution precedence to, per date:

1. `employee_extra_weekly_offs` exact date match → `WEEKLY_OFF` (most specific: a named
   person, a named day).
2. `employee_weekly_off_assignments` — active row whose weekday matches and whose
   `[effective_from, effective_to]` covers the date → `WEEKLY_OFF`.
3. Existing `weekly_off_rules` resolution (unchanged) → `WEEKLY_OFF`/`HOLIDAY`.
4. `WORKING`.

**Performance note:** `buildCalendarContext` currently caches resolved days per
department+location *scope*, shared across every employee in that scope
([calendar.service.ts:141-178](server/src/modules/calendar/calendar.service.ts#L141-L178)) —
this is what keeps payroll's per-employee resolution cheap. Per-employee overrides can't
share that cache. Keep the department/location-scoped cache exactly as-is for the rule
fallback, and layer the employee-specific lookups as two small precomputed maps built once
per `buildCalendarContext` call:
`Map<employeeId, Map<weekday, {from, to}>>` (recurring) and
`Map<employeeId, Set<date>>` (one-off) — both O(rows in range), checked before falling
through to the existing scope cache. This avoids turning an O(employees × dates) rule
resolution into one, which matters for payroll runs over thousands of employees
(the exact concern the existing code comment at
[calendar.service.ts:116-118](server/src/modules/calendar/calendar.service.ts#L116-L118) calls out).

### 4.3 Permissions

Add to [permissions.ts](server/src/modules/auth/permissions.ts):

```ts
WEEKLY_OFF_ASSIGN_TEAM: 'weeklyoff.assign.team',
```

`WEEKLY_OFF_MANAGE` (existing, super-admin-only today) continues to cover assigning any
employee. Add `WEEKLY_OFF_ASSIGN_TEAM` to `SUPERVISOR_PERMISSIONS`
([permissions.ts:247-279](server/src/modules/auth/permissions.ts#L247-L279)) so
supervisors can assign only their own team — resolved exactly like attendance's
`manageScope` ([attendance.service.ts:45-50](server/src/modules/attendance/attendance.service.ts#L45-L50)):

```ts
resolveScope(auth, { all: PERMISSIONS.WEEKLY_OFF_MANAGE, team: PERMISSIONS.WEEKLY_OFF_ASSIGN_TEAM })
```

then `scopeClause`/`assertEmployeeInScope` from
[employee-access.ts](server/src/modules/employees/employee-access.ts) restrict which
employee ids a given supervisor may assign — the same mechanism already proven for
attendance and leave.

### 4.4 API (new endpoints on the `calendar` module)

- `GET /weekly-off-assignments/calendar?weekStart=YYYY-MM-DD` — for the caller's scope,
  returns every in-scope employee plus, for each of the 7 days in that week, the
  currently-resolved day kind (reusing `buildCalendarContext`/`dayFor`) and whether it
  came from a rule, a recurring assignment, or a one-off grant — this is what renders the
  calendar grid with pre-filled state.
- `POST /weekly-off-assignments` — body `{ weekday, effectiveFrom, employeeIds: string[] }`.
  In a transaction: for each `employeeId` (scope-checked), close any existing open
  recurring assignment (`effective_to = effectiveFrom - 1 day`) and insert the new one —
  same "full replace" spirit as `replaceWeeklyOffRuleDays` already uses for rules.
- `POST /weekly-off-assignments/one-off` — body `{ offDate, employeeIds: string[] }` →
  inserts into `employee_extra_weekly_offs` with `source = 'ADMIN_ASSIGNED'`.
- `DELETE /weekly-off-assignments/:id` — clears an assignment (employee reverts to
  falling back to rules).

Gate all of these with `requirePermissions`/scope resolution as in 4.3, matching how
[calendar.routes.ts](server/src/modules/calendar/calendar.routes.ts) already gates
`/weekly-offs`.

### 4.5 Frontend

Add a `WeeklyOffAssignmentCalendar` component (new — no calendar-grid component exists
today; `WeeklyOffsTab` in [CalendarPage.tsx:271-548](src/features/calendar/CalendarPage.tsx#L271-L548)
is a list+modal, not a grid). Suggested placement: a third tab, "Employee assignments",
alongside the existing Holidays/Weekly offs tabs in `CalendarPage.tsx`
([CalendarPage.tsx:53-62](src/features/calendar/CalendarPage.tsx#L53-L62)) — same
component that both Admin and Supervisor land on, since the API already scopes results.

- A week-grid: 7 day columns, clicking any date jumps the view to that date's week.
- Each day column lists employees currently off that day (from the resolved calendar) as
  chips, with an "Assign" action opening an employee multi-select (source list already
  scoped server-side — admin sees all, supervisor sees only their team, no client-side
  filtering needed).
- On confirm: a toggle "Apply to future weeks" (default on, recurring →
  `POST /weekly-off-assignments`) vs off (one-off → `POST /weekly-off-assignments/one-off`).
- Reuse `Modal`, `Field`, `Select`, `DataTable`/chip list, and the existing employee-search
  pattern used elsewhere (e.g. wherever `AttendancePage` picks employees for bulk actions)
  rather than building a new employee picker from scratch.

---

## 5. Phase 3 — Overtime

### 5.1 Schema — new migration `0013_overtime.sql`

```sql
CREATE TYPE overtime_status AS ENUM ('RECORDED', 'LOCKED');  -- LOCKED once payroll consumes it

CREATE TABLE overtime_entries (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  employee_id            UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  work_date              DATE NOT NULL,
  hours                  NUMERIC(4,2) NOT NULL CHECK (hours > 0),
  status                 overtime_status NOT NULL DEFAULT 'RECORDED',
  remarks                TEXT,
  locked_by_payroll_run_id UUID REFERENCES payroll_runs (id) ON DELETE SET NULL,
  marked_by              UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT overtime_entries_unique UNIQUE (employee_id, work_date)
);
CREATE INDEX overtime_entries_employee_id_idx ON overtime_entries (employee_id, work_date);
CREATE TRIGGER overtime_entries_set_updated_at BEFORE UPDATE ON overtime_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE employee_extra_weekly_offs
  ADD CONSTRAINT employee_extra_weekly_offs_overtime_fk
  FOREIGN KEY (overtime_entry_id) REFERENCES overtime_entries (id) ON DELETE SET NULL;

-- PSR per-hour OT rate: an org default, with a per-employee override for flexibility,
-- mirroring employee_salary_assignments.override_amount.
ALTER TABLE payroll_policies ADD COLUMN psr_overtime_rate_minor INTEGER CHECK (psr_overtime_rate_minor IS NULL OR psr_overtime_rate_minor >= 0);
ALTER TABLE employees ADD COLUMN overtime_rate_override_minor INTEGER CHECK (overtime_rate_override_minor IS NULL OR overtime_rate_override_minor >= 0);
```

(`hours` allows half-hour granularity; tighten to `INTEGER` if the business never records
fractional OT.)

### 5.2 Service logic (`overtime.service.ts`, new module `server/src/modules/overtime/`)

Follows the same module shape as `attendance` (`.validation.ts` / `.repository.ts` /
`.service.ts` / `.controller.ts` / `.routes.ts`).

**On recording/editing an OT entry for a `SUPPLY` employee:**
1. Reject if the target date falls in a period already `locked_by_payroll_run_id`
   (mirrors `assertNotPayrollLocked` in
   [attendance.service.ts:56-68](server/src/modules/attendance/attendance.service.ts#L56-L68)).
2. Recompute the employee's total *approved* OT hours for the ISO week containing
   `work_date` (sum of `overtime_entries.hours` for that employee across Mon–Sun).
3. Convert: `extraOffsEarned = min(floor(totalWeekHours / 8), 2)` (open question 2's cap).
4. Reconcile `employee_extra_weekly_offs` rows with `source = 'OVERTIME_CONVERSION'` for
   that employee/week so the count always matches `extraOffsEarned` — i.e. this is
   recomputed from scratch each time an OT entry in that week changes (add/edit/delete),
   not incrementally, to avoid drift. Which *dates* within the week become the extra
   off(s) needs a pick: default to the first not-yet-off working day(s) of that week
   (skipping days already WEEKLY_OFF from any other source), but the calendar UI (4.5)
   should let the assigning supervisor/admin pick if the default isn't right — confirm
   whether auto-pick-only is acceptable or a manual picker is required for launch.
5. If `totalWeekHours` isn't a multiple of 8, or exceeds 16, attach a non-blocking warning
   to the response (per open questions 1–2) rather than silently truncating.

**On recording an OT entry for a `PSR` employee:** no conversion — it's purely a payroll
input, resolved at payroll time (5.3). No extra-off bookkeeping needed.

### 5.3 Payroll integration

[payroll.service.ts](server/src/modules/payroll/payroll.service.ts) already batch-loads
attendance/leave/salary/deductions/bonuses per employee for a run
([payroll.service.ts:290-318](server/src/modules/payroll/payroll.service.ts#L290-L318)).
Add, for `PSR` employees only, a load of `overtime_entries` within the run's (now
cycle-aware, per Phase 0) period, sum `hours`, and resolve the rate as
`employee.overtime_rate_override_minor ?? policy.psr_overtime_rate_minor` — falling back
to a payroll-blocking warning if neither is configured (same pattern as the existing
"PF marked applicable but no PF rule configured" warning at
[payroll.calculator.ts:702-704](server/src/modules/payroll/payroll.calculator.ts#L702-L704)).

Extend `CalculatorInput` ([payroll.calculator.ts:135-160](server/src/modules/payroll/payroll.calculator.ts#L135-L160))
with:

```ts
overtime: { hours: number; rateMinor: Minor | null } | null
```

and in `calculatePayrollItem`, right after the bonus loop
([payroll.calculator.ts:627-652](server/src/modules/payroll/payroll.calculator.ts#L627-L652)),
add an `OVERTIME` earning component when `overtime.rateMinor` is set:
`amountMinor = multiplyMinor(overtime.rateMinor, overtime.hours)`, added into
`grossEarningsMinor` exactly like a bonus. For `SUPPLY` employees this field is simply
`null` — no code branch needed inside the calculator beyond the existing "skip if
amount is 0/null" shape bonuses already use.

Mark consumed `overtime_entries` rows with `locked_by_payroll_run_id` when the run locks,
mirroring how attendance rows get locked, so a locked OT record can only be corrected via
a payroll adjustment ([payroll_adjustments](server/src/database/migrations/0008_payroll.sql#L195-L221)),
consistent with how every other locked-period correction already works in this system.

### 5.4 Permissions

```ts
OVERTIME_VIEW_ALL: 'overtime.view.all',
OVERTIME_VIEW_TEAM: 'overtime.view.team',
OVERTIME_VIEW_SELF: 'overtime.view.self',
OVERTIME_MANAGE_ALL: 'overtime.manage.all',
OVERTIME_MANAGE_TEAM: 'overtime.manage.team',
```

`OVERTIME_MANAGE_TEAM` → `SUPERVISOR_PERMISSIONS`; `OVERTIME_VIEW_SELF` →
`EMPLOYEE_PERMISSIONS` (so an employee can see their own OT and resulting extra
weekly-offs, same shape as `ATTENDANCE_VIEW_SELF`/`ATTENDANCE_MANAGE_TEAM`).

### 5.5 Frontend

- New `OvertimePage` (or a tab on `AttendancePage`, since OT is recorded per employee per
  date like attendance): a daily/weekly entry table — employee, date, hours, remarks —
  scoped the same way the attendance daily sheet is.
  For `SUPPLY` rows, show a running "this week: X/16 hrs → Y extra off(s)" indicator next
  to the entry so the conversion is visible immediately, not just after saving.
  For `PSR` rows, show the resolved rate and running OT earnings for the current cycle.
- Reflect OT-converted extra offs on `MonthlyCalendarView.tsx` / `MyAttendancePage.tsx`
  the same way any other `WEEKLY_OFF` day renders today — no separate UI needed there
  since Phase 2's calendar resolution already folds them into `dayKind`.
- Payslip/salary breakdown views ([SalaryPage.tsx](src/features/salary/SalaryPage.tsx),
  `MyPayslipsPage`) should render the new `OVERTIME` component like any other earning
  line — likely needs no code change if those views already iterate
  `payroll_item_components` generically; verify before assuming.

---

## 6. Cross-cutting checklist

### 6.1 Migrations (in order)

| File | Contents |
|---|---|
| `0011_employee_type_plant.sql` | `employee_type`, `plant_type` enums; `employees.employee_type`, `employees.plant`; job-history enum + columns |
| `0012_employee_weekly_off_assignments.sql` | `employee_weekly_off_assignments`, `employee_extra_weekly_offs` (OT FK added in 0013) |
| `0013_overtime.sql` | `overtime_entries`, `payroll_policies.psr_overtime_rate_minor`, `employees.overtime_rate_override_minor`, extra-off FK |
| `0014_payroll_cycle.sql` | `payroll_policies.cycle_cutoff_day` |

(Phase 0's migration is listed last only because it's the smallest/safest; sequence
doesn't otherwise matter between these four, but all of Phase 1–3 should land after or
alongside Phase 0 since Phase 3's payroll integration depends on cycle-aware periods.)

### 6.2 Permission additions summary

| Permission | Super Admin | Supervisor | Employee |
|---|---|---|---|
| `weeklyoff.assign.team` (new) | via `weeklyoff.manage` | ✅ new | — |
| `overtime.view.all/.team/.self` (new) | ✅ all | ✅ team | ✅ self |
| `overtime.manage.all/.team` (new) | ✅ all | ✅ team | — |

### 6.3 Explicitly out of scope

Carried over from the README wishlist ([README.md:280-297](README.md#L280-L297)) but
**not** part of this request — call out separately if wanted later:
- Shift select box (A/B/C/G) on attendance rows (item 2).
- Modal typing/focus bug (item 5).
- Salary component creation UI gap (item 6).
- The specific numeric constants for a 21k salary tier (item 7).
- PF/ESI/salary reports (item 8).

### 6.4 Testing

- `dates.test.ts`: `payCycleFor`/`payCycleContaining` across month lengths, leap years,
  and the `cutoffDay = null` passthrough case.
- `calendar.service.test.ts`: resolution precedence (one-off > recurring assignment >
  rule > working), and that an employee-level override doesn't leak into another
  employee's resolution in the same scope cache.
- `overtime.service.test.ts`: 8/16-hour boundary conversion, non-multiple-of-8 warning,
  >16-hour cap warning, PSR rate resolution (override vs policy default vs neither configured).
- `payroll.calculator.test.ts`: new `OVERTIME` component present/absent correctly for
  PSR/SUPPLY, and existing snapshot totals still reconcile.
- `authorization.test.ts`: supervisor blocked (403) from assigning weekly-off/OT outside
  their team, same shape as existing attendance scope tests.

---

## 7. Suggested build order

1. Phase 0 (payroll cycle) — foundational, low risk, unblocks correct period math everywhere else.
2. Phase 1 (employee type/plant/location section) — needed before Phase 3 can branch on `employee_type`.
3. Phase 2 (weekly-off calendar) — independent of Phase 3, but shares the calendar resolver Phase 3's Supply conversion writes into.
4. Phase 3 (overtime) — depends on 1 and 2.
5. Confirm open questions in §1 before finalizing Phase 3's conversion/cap behavior.
