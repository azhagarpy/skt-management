import { ApiError } from '../../utils/api-error.js'
import { withTransaction } from '../../database/tx.js'
import { pool, queryOne, type Queryable } from '../../database/pool.js'
import { buildPaginated, type Paginated } from '../../utils/pagination.js'
import { addDays, countDaysBetween, datesBetween, type IsoDate } from '../../utils/dates.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { assertEmployeeInScope, resolveScope, scopeClause, type EmployeeScope } from '../employees/employee-access.js'
import { buildCalendarContext } from '../calendar/calendar.service.js'
import * as attendanceRepository from '../attendance/attendance.repository.js'
import { notifyUser, notifyUserForEmployee } from '../notifications/notifications.service.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './leave.repository.js'
import type {
  BalanceAdjustmentInput,
  CancelInput,
  CreateLeaveRequestInput,
  DecisionInput,
  LeavePolicyInput,
  LeaveRequestListQuery,
  LeaveTypeInput,
  RejectInput,
  UpdateLeaveTypeInput,
} from './leave.validation.js'

function viewScope(auth: AuthContext): EmployeeScope {
  return resolveScope(auth, {
    all: PERMISSIONS.LEAVE_VIEW_ALL,
    team: PERMISSIONS.LEAVE_VIEW_TEAM,
    self: PERMISSIONS.LEAVE_VIEW_SELF,
  })
}

function approveScope(auth: AuthContext): EmployeeScope {
  return resolveScope(auth, {
    all: PERMISSIONS.LEAVE_APPROVE_ALL,
    team: PERMISSIONS.LEAVE_APPROVE_TEAM,
  })
}

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

function presentLeaveType(row: repository.LeaveTypeRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    annualLimit: row.annual_limit === null ? null : Number(row.annual_limit),
    isPaid: row.is_paid,
    requiresApproval: row.requires_approval,
    allowHalfDay: row.allow_half_day,
    excludeWeeklyOff: row.exclude_weekly_off,
    excludeHolidays: row.exclude_holidays,
    sandwichHolidays: row.sandwich_holidays,
    maxConsecutiveDays: row.max_consecutive_days,
    requiresAttachment: row.requires_attachment,
    isActive: row.is_active,
  }
}

function presentPolicy(row: repository.LeavePolicyRow) {
  return {
    id: row.id,
    leaveTypeId: row.leave_type_id,
    leaveTypeName: row.leave_type_name ?? null,
    name: row.name,
    employmentType: row.employment_type,
    departmentId: row.department_id,
    accrualPeriod: row.accrual_period,
    accrualAmount: Number(row.accrual_amount),
    openingBalance: Number(row.opening_balance),
    carryForwardAllowed: row.carry_forward_allowed,
    maxCarryForward: row.max_carry_forward === null ? null : Number(row.max_carry_forward),
    allowNegativeBalance: row.allow_negative_balance,
    minServiceDays: row.min_service_days,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    isActive: row.is_active,
  }
}

function presentBalance(row: repository.LeaveBalanceRow) {
  const entitled = Number(row.opening_balance) + Number(row.accrued) + Number(row.carried_forward) + Number(row.adjustment)
  const used = Number(row.used)
  const pending = Number(row.pending)
  return {
    id: row.id,
    leaveTypeId: row.leave_type_id,
    leaveTypeName: row.leave_type_name ?? null,
    leaveTypeCode: row.leave_type_code ?? null,
    isPaid: row.is_paid ?? null,
    year: row.leave_year,
    openingBalance: Number(row.opening_balance),
    accrued: Number(row.accrued),
    carriedForward: Number(row.carried_forward),
    adjustment: Number(row.adjustment),
    entitled: Number(entitled.toFixed(2)),
    used,
    pending,
    available: Number((entitled - used - pending).toFixed(2)),
  }
}

function presentRequest(row: repository.LeaveRequestWithDetailsRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code,
    employeeName: [row.first_name, row.last_name].filter(Boolean).join(' '),
    departmentName: row.department_name,
    leaveTypeId: row.leave_type_id,
    leaveTypeName: row.leave_type_name,
    leaveTypeCode: row.leave_type_code,
    isPaid: row.is_paid,
    fromDate: row.from_date,
    toDate: row.to_date,
    dayPortion: row.day_portion,
    totalDays: Number(row.total_days),
    reason: row.reason,
    status: row.status,
    attachmentId: row.attachment_id,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
    decisionComment: row.decision_comment,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Leave day calculation
// ---------------------------------------------------------------------------

export interface LeaveDayBreakdown {
  /** Dates that actually consume leave. */
  leaveDates: IsoDate[]
  /** The subset of `leaveDates` that are holidays charged by the sandwich rule. */
  sandwichedDates: IsoDate[]
  totalDays: number
}

/**
 * How far either side of a request the sandwich rule looks for the leave that
 * brackets a holiday. A week is more than enough for any run of holidays and
 * keeps the scan - and the surprise - bounded.
 */
const SANDWICH_SCAN_DAYS = 7

/**
 * Works out which dates in a request consume leave.
 *
 * Weekly offs and holidays inside the range are excluded when the leave type
 * says so, so a Friday-to-Monday request over a weekend costs two days, not
 * four. Nothing here assumes which days are non-working: that comes from the
 * configured calendar (plan sections 8, 9 and 10).
 *
 * The sandwich rule then adds back the holidays that leave surrounds on both
 * sides, which is the point of `sandwich_holidays`: taking the day before and
 * the day after a holiday costs the holiday too. Those dates can lie outside
 * the request's own range, because the leave on either side is usually a
 * separate request - so the returned `leaveDates` are not always within
 * from..to, and everything downstream works from that list rather than from
 * the range.
 */
export async function computeLeaveDays(
  organizationId: string,
  employee: { id?: string; departmentId: string | null; locationId: string | null },
  leaveType: repository.LeaveTypeRow,
  from: IsoDate,
  to: IsoDate,
  dayPortion: 'FULL_DAY' | 'HALF_DAY',
  db: Queryable = pool,
): Promise<LeaveDayBreakdown> {
  // A half day is never part of a sandwich: the employee worked half of it.
  const applySandwich = leaveType.sandwich_holidays && dayPortion === 'FULL_DAY'
  const scanFrom = applySandwich ? addDays(from, -SANDWICH_SCAN_DAYS) : from
  const scanTo = applySandwich ? addDays(to, SANDWICH_SCAN_DAYS) : to
  // One day of slack each side, so a run at the edge of the scan still has a
  // neighbour to be judged against.
  const calendar = await buildCalendarContext(organizationId, addDays(scanFrom, -1), addDays(scanTo, 1), db)
  const scope = { departmentId: employee.departmentId, locationId: employee.locationId, employeeId: employee.id ?? null }
  const kindOf = (date: IsoDate): 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY' => calendar.dayFor(date, scope).kind

  const leaveDates: IsoDate[] = []
  for (const date of datesBetween(from, to)) {
    const kind = kindOf(date)
    if (kind === 'WEEKLY_OFF' && leaveType.exclude_weekly_off) continue
    if (kind === 'HOLIDAY' && leaveType.exclude_holidays) continue
    leaveDates.push(date)
  }

  if (!applySandwich || leaveDates.length === 0) {
    const totalDays = dayPortion === 'HALF_DAY' ? 0.5 : leaveDates.length
    return { leaveDates, sandwichedDates: [], totalDays }
  }

  const sandwichedDates = await sandwichedHolidays(
    employee.id ?? null,
    new Set(leaveDates),
    kindOf,
    scanFrom,
    scanTo,
    db,
  )
  const all = [...leaveDates, ...sandwichedDates].sort()
  return { leaveDates: all, sandwichedDates, totalDays: all.length }
}

/**
 * Reads the leave already on record and applies the sandwich rule to it.
 *
 * Everything that needs the database is here; the rule itself is
 * `sandwichedHolidayDates` below.
 */
async function sandwichedHolidays(
  employeeId: string | null,
  charged: Set<IsoDate>,
  kindOf: (date: IsoDate) => 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY',
  scanFrom: IsoDate,
  scanTo: IsoDate,
  db: Queryable,
): Promise<IsoDate[]> {
  if (!employeeId) return []

  const existing = new Set(
    await attendanceRepository.findFullDayLeaveDates(employeeId, addDays(scanFrom, -1), addDays(scanTo, 1), db),
  )
  return sandwichedHolidayDates({ charged, existing, kindOf, scanFrom, scanTo })
}

export interface SandwichInput {
  /** Days this request is already paying for. */
  charged: Set<IsoDate>
  /** Days the employee was already on full-day leave, from other requests. */
  existing: Set<IsoDate>
  kindOf: (date: IsoDate) => 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY'
  scanFrom: IsoDate
  scanTo: IsoDate
}

/**
 * The holidays a request turns into leave because leave sits on both sides.
 *
 * A run of consecutive holidays is charged only when the day before it and the
 * day after it are both full days of leave, and at least one of those two is a
 * day this request is paying for - otherwise a sandwich formed entirely by
 * older requests would be billed again to whichever request happened to be
 * counted next. A weekly off between the leave and the holiday breaks the run:
 * only an unbroken stretch of holidays is charged, which keeps the rule one a
 * supervisor can check by eye.
 */
export function sandwichedHolidayDates({ charged, existing, kindOf, scanFrom, scanTo }: SandwichInput): IsoDate[] {
  const isLeaveDay = (date: IsoDate): boolean => charged.has(date) || existing.has(date)

  // Runs of consecutive holidays that nothing has charged yet: a two-day
  // festival between two days of leave is one sandwich, not two. A holiday an
  // earlier request already sandwiched is not free either - it is leave now,
  // so it brackets the next run rather than being charged a second time.
  const isFreeHoliday = (date: IsoDate): boolean =>
    kindOf(date) === 'HOLIDAY' && !charged.has(date) && !existing.has(date)
  const runs: IsoDate[][] = []
  let run: IsoDate[] = []
  for (const date of datesBetween(scanFrom, scanTo)) {
    if (isFreeHoliday(date)) {
      run.push(date)
    } else if (run.length > 0) {
      runs.push(run)
      run = []
    }
  }
  if (run.length > 0) runs.push(run)

  const sandwiched: IsoDate[] = []
  for (const dates of runs) {
    const first = dates[0]
    const last = dates[dates.length - 1]
    if (!first || !last) continue

    const before = addDays(first, -1)
    const after = addDays(last, 1)
    if (isLeaveDay(before) && isLeaveDay(after) && (charged.has(before) || charged.has(after))) {
      sandwiched.push(...dates)
    }
  }

  return sandwiched
}

// ---------------------------------------------------------------------------
// Leave types and policies
// ---------------------------------------------------------------------------

export async function listLeaveTypes(auth: AuthContext, activeOnly: boolean) {
  const rows = await repository.listLeaveTypes(auth.organizationId, activeOnly)
  return rows.map(presentLeaveType)
}

export async function createLeaveType(auth: AuthContext, input: LeaveTypeInput, context: AuditContext) {
  const row = await repository.insertLeaveType({
    organization_id: auth.organizationId,
    name: input.name,
    code: input.code,
    description: input.description ?? null,
    annual_limit: input.annualLimit ?? null,
    is_paid: input.isPaid,
    requires_approval: input.requiresApproval,
    allow_half_day: input.allowHalfDay,
    exclude_weekly_off: input.excludeWeeklyOff,
    exclude_holidays: input.excludeHolidays,
    sandwich_holidays: input.sandwichHolidays,
    max_consecutive_days: input.maxConsecutiveDays ?? null,
    requires_attachment: input.requiresAttachment,
    is_active: input.isActive,
  })

  await recordAudit({
    ...context,
    action: 'LEAVE_TYPE_CREATED',
    entityType: 'leave_type',
    entityId: row.id,
    newValues: presentLeaveType(row),
  })

  return presentLeaveType(row)
}

export async function updateLeaveType(
  auth: AuthContext,
  id: string,
  input: UpdateLeaveTypeInput,
  context: AuditContext,
) {
  const existing = await repository.findLeaveType(id, auth.organizationId)
  if (!existing) throw ApiError.notFound('Leave type')

  const row = await repository.updateLeaveType(id, auth.organizationId, {
    name: input.name,
    code: input.code,
    description: input.description,
    annual_limit: input.annualLimit,
    is_paid: input.isPaid,
    requires_approval: input.requiresApproval,
    allow_half_day: input.allowHalfDay,
    exclude_weekly_off: input.excludeWeeklyOff,
    exclude_holidays: input.excludeHolidays,
    sandwich_holidays: input.sandwichHolidays,
    max_consecutive_days: input.maxConsecutiveDays,
    requires_attachment: input.requiresAttachment,
    is_active: input.isActive,
  })
  if (!row) throw ApiError.notFound('Leave type')

  await recordAudit({
    ...context,
    action: 'LEAVE_TYPE_UPDATED',
    entityType: 'leave_type',
    entityId: id,
    oldValues: presentLeaveType(existing),
    newValues: presentLeaveType(row),
  })

  return presentLeaveType(row)
}

export async function listLeavePolicies(auth: AuthContext) {
  const rows = await repository.listLeavePolicies(auth.organizationId)
  return rows.map(presentPolicy)
}

export async function createLeavePolicy(auth: AuthContext, input: LeavePolicyInput, context: AuditContext) {
  const leaveType = await repository.findLeaveType(input.leaveTypeId, auth.organizationId)
  if (!leaveType) throw ApiError.badRequest('The selected leave type does not exist')

  const row = await repository.insertLeavePolicy({
    organization_id: auth.organizationId,
    leave_type_id: input.leaveTypeId,
    name: input.name,
    employment_type: input.employmentType ?? null,
    department_id: input.departmentId ?? null,
    accrual_period: input.accrualPeriod,
    accrual_amount: input.accrualAmount,
    opening_balance: input.openingBalance,
    carry_forward_allowed: input.carryForwardAllowed,
    max_carry_forward: input.maxCarryForward ?? null,
    allow_negative_balance: input.allowNegativeBalance,
    min_service_days: input.minServiceDays,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo ?? null,
    is_active: input.isActive,
  })

  await recordAudit({
    ...context,
    action: 'LEAVE_POLICY_UPDATED',
    entityType: 'leave_policy',
    entityId: row.id,
    newValues: presentPolicy(row),
  })

  return presentPolicy(row)
}

export async function updateLeavePolicy(
  auth: AuthContext,
  id: string,
  input: LeavePolicyInput,
  context: AuditContext,
) {
  const row = await repository.updateLeavePolicy(id, auth.organizationId, {
    leave_type_id: input.leaveTypeId,
    name: input.name,
    employment_type: input.employmentType ?? null,
    department_id: input.departmentId ?? null,
    accrual_period: input.accrualPeriod,
    accrual_amount: input.accrualAmount,
    opening_balance: input.openingBalance,
    carry_forward_allowed: input.carryForwardAllowed,
    max_carry_forward: input.maxCarryForward ?? null,
    allow_negative_balance: input.allowNegativeBalance,
    min_service_days: input.minServiceDays,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo ?? null,
    is_active: input.isActive,
  })
  if (!row) throw ApiError.notFound('Leave policy')

  await recordAudit({
    ...context,
    action: 'LEAVE_POLICY_UPDATED',
    entityType: 'leave_policy',
    entityId: id,
    newValues: presentPolicy(row),
  })

  return presentPolicy(row)
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

interface EmployeeContext {
  id: string
  department_id: string | null
  location_id: string | null
  employment_type: string
  joining_date: IsoDate
  exit_date: IsoDate | null
  supervisor_id: string | null
  first_name: string
  last_name: string | null
  employee_code: string
}

async function loadEmployee(employeeId: string, organizationId: string, db: Queryable): Promise<EmployeeContext> {
  const row = await queryOne<EmployeeContext>(
    db,
    `SELECT id, department_id, location_id, employment_type::text AS employment_type,
            joining_date, exit_date, supervisor_id, first_name, last_name, employee_code
       FROM employees WHERE id = $1 AND organization_id = $2`,
    [employeeId, organizationId],
  )
  if (!row) throw ApiError.notFound('Employee')
  return row
}

/**
 * Reads an employee's balances, seeding any missing rows from the applicable
 * policy so a new starter sees their entitlement immediately.
 */
export async function getBalances(auth: AuthContext, employeeId: string, year: number) {
  await assertEmployeeInScope(auth, employeeId, viewScope(auth))

  return withTransaction(async (tx) => {
    const employee = await loadEmployee(employeeId, auth.organizationId, tx)
    const leaveTypes = await repository.listLeaveTypes(auth.organizationId, true, tx)
    const onDate: IsoDate = `${year}-01-01`

    for (const leaveType of leaveTypes) {
      const policy = await repository.findApplicablePolicy(
        auth.organizationId,
        leaveType.id,
        employee.employment_type,
        employee.department_id,
        onDate,
        tx,
      )
      const opening = policy ? Number(policy.opening_balance) : 0
      const accrued = policy ? Number(policy.accrual_amount) : Number(leaveType.annual_limit ?? 0)

      await repository.ensureBalance(
        {
          organizationId: auth.organizationId,
          employeeId,
          leaveTypeId: leaveType.id,
          year,
          openingBalance: opening,
          accrued,
        },
        tx,
      )
    }

    const rows = await repository.listBalances(employeeId, year, tx)
    return rows.map(presentBalance)
  })
}

export async function adjustBalance(auth: AuthContext, input: BalanceAdjustmentInput, context: AuditContext) {
  await assertEmployeeInScope(auth, input.employeeId, 'ALL')

  await withTransaction(async (tx) => {
    await repository.ensureBalance(
      {
        organizationId: auth.organizationId,
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        year: input.year,
        openingBalance: 0,
        accrued: 0,
      },
      tx,
    )
    await repository.adjustBalance(
      input.employeeId,
      input.leaveTypeId,
      input.year,
      { adjustment: input.adjustment },
      tx,
    )
    await recordAudit(
      {
        ...context,
        action: 'LEAVE_BALANCE_ADJUSTED',
        entityType: 'employee_leave_balance',
        entityId: input.employeeId,
        newValues: {
          leaveTypeId: input.leaveTypeId,
          year: input.year,
          adjustment: input.adjustment,
          reason: input.reason,
        },
      },
      tx,
    )
  })

  const rows = await repository.listBalances(input.employeeId, input.year)
  return rows.map(presentBalance)
}

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

export async function listLeaveRequests(
  auth: AuthContext,
  filters: LeaveRequestListQuery,
): Promise<Paginated<ReturnType<typeof presentRequest>>> {
  const scope = viewScope(auth)
  const clause = scopeClause(auth, scope, 'e', 1)

  const employeeId =
    filters.employeeId === 'me' ? (auth.employeeId ?? undefined) : (filters.employeeId as string | undefined)

  const { rows, total } = await repository.listLeaveRequests(clause, { ...filters, employeeId })
  return buildPaginated(rows.map(presentRequest), total, filters.page, filters.pageSize)
}

export async function getLeaveRequest(auth: AuthContext, id: string) {
  const row = await repository.findLeaveRequest(id, auth.organizationId)
  if (!row) throw ApiError.notFound('Leave request')
  await assertEmployeeInScope(auth, row.employee_id, viewScope(auth))

  const approvals = await repository.listApprovals(id)
  return { ...presentRequest(row), approvals }
}

export async function createLeaveRequest(
  auth: AuthContext,
  input: CreateLeaveRequestInput,
  context: AuditContext,
) {
  // Applying for someone else requires the wider approval permission.
  const employeeId = input.employeeId ?? auth.employeeId
  if (!employeeId) throw ApiError.businessRule('Your user account is not linked to an employee record')

  if (input.employeeId && input.employeeId !== auth.employeeId) {
    await assertEmployeeInScope(auth, input.employeeId, approveScope(auth))
  }

  return withTransaction(async (tx) => {
    const employee = await loadEmployee(employeeId, auth.organizationId, tx)
    const leaveType = await repository.findLeaveType(input.leaveTypeId, auth.organizationId, tx)
    if (!leaveType || !leaveType.is_active) throw ApiError.badRequest('The selected leave type is not available')

    if (input.dayPortion === 'HALF_DAY' && !leaveType.allow_half_day) {
      throw ApiError.businessRule('Half day leave is not allowed for this leave type')
    }
    if (leaveType.requires_attachment && !input.attachmentId) {
      throw ApiError.businessRule('This leave type requires a supporting document')
    }
    if (input.fromDate < employee.joining_date) {
      throw ApiError.businessRule('Leave cannot start before the joining date')
    }
    if (employee.exit_date && input.toDate > employee.exit_date) {
      throw ApiError.businessRule('Leave cannot extend past the employee exit date')
    }

    const spanDays = countDaysBetween(input.fromDate, input.toDate)
    if (leaveType.max_consecutive_days && spanDays > leaveType.max_consecutive_days) {
      throw ApiError.businessRule(
        `This leave type allows at most ${leaveType.max_consecutive_days} consecutive day(s)`,
      )
    }

    const breakdown = await computeLeaveDays(
      auth.organizationId,
      { id: employee.id, departmentId: employee.department_id, locationId: employee.location_id },
      leaveType,
      input.fromDate,
      input.toDate,
      input.dayPortion,
      tx,
    )

    if (breakdown.totalDays <= 0) {
      throw ApiError.businessRule(
        'The selected dates contain no working days for this leave type',
      )
    }

    // Balance check, unless the applicable policy permits going negative.
    const year = Number(input.fromDate.slice(0, 4))
    const policy = await repository.findApplicablePolicy(
      auth.organizationId,
      leaveType.id,
      employee.employment_type,
      employee.department_id,
      input.fromDate,
      tx,
    )

    await repository.ensureBalance(
      {
        organizationId: auth.organizationId,
        employeeId,
        leaveTypeId: leaveType.id,
        year,
        openingBalance: policy ? Number(policy.opening_balance) : 0,
        accrued: policy ? Number(policy.accrual_amount) : Number(leaveType.annual_limit ?? 0),
      },
      tx,
    )

    const balance = await repository.findBalance(employeeId, leaveType.id, year, tx)
    if (balance) {
      const entitled =
        Number(balance.opening_balance) +
        Number(balance.accrued) +
        Number(balance.carried_forward) +
        Number(balance.adjustment)
      const available = entitled - Number(balance.used) - Number(balance.pending)
      const allowNegative = policy?.allow_negative_balance ?? false
      if (!allowNegative && breakdown.totalDays > available) {
        throw ApiError.businessRule(
          `Insufficient ${leaveType.name} balance: ${available} day(s) available, ${breakdown.totalDays} requested`,
        )
      }
    }

    // A leave type that needs no approval is granted immediately.
    const status = leaveType.requires_approval ? 'PENDING' : 'APPROVED'

    const request = await repository.insertLeaveRequest(
      {
        organization_id: auth.organizationId,
        employee_id: employeeId,
        leave_type_id: leaveType.id,
        from_date: input.fromDate,
        to_date: input.toDate,
        day_portion: input.dayPortion,
        total_days: breakdown.totalDays,
        reason: input.reason,
        status,
        attachment_id: input.attachmentId ?? null,
        applied_by: auth.userId,
      },
      tx,
    )

    if (status === 'PENDING') {
      await repository.adjustBalance(employeeId, leaveType.id, year, { pending: breakdown.totalDays }, tx)
    } else {
      await repository.adjustBalance(employeeId, leaveType.id, year, { used: breakdown.totalDays }, tx)
      await writeLeaveAttendance(auth, request.id, employeeId, leaveType.id, breakdown.leaveDates, input.dayPortion, tx)
    }

    await recordAudit(
      {
        ...context,
        action: 'LEAVE_REQUESTED',
        entityType: 'leave_request',
        entityId: request.id,
        newValues: {
          employeeId,
          leaveType: leaveType.code,
          from: input.fromDate,
          to: input.toDate,
          days: breakdown.totalDays,
          status,
        },
      },
      tx,
    )

    // Tell the supervisor there is something to action.
    if (status === 'PENDING' && employee.supervisor_id) {
      const supervisorUser = await queryOne<{ user_id: string | null }>(
        tx,
        'SELECT user_id FROM employees WHERE id = $1',
        [employee.supervisor_id],
      )
      if (supervisorUser?.user_id) {
        await notifyUser(
          supervisorUser.user_id,
          {
            organizationId: auth.organizationId,
            type: 'LEAVE_REQUEST_SUBMITTED',
            title: 'New leave request',
            body: `${employee.first_name} ${employee.last_name ?? ''} requested ${breakdown.totalDays} day(s) of ${leaveType.name}.`,
            link: `/leave/requests/${request.id}`,
            metadata: { leaveRequestId: request.id },
          },
          tx,
        )
      }
    }

    const detail = await repository.findLeaveRequest(request.id, auth.organizationId, tx)
    return detail ? presentRequest(detail) : null
  })
}

/**
 * Writes the attendance rows implied by an approved leave.
 *
 * Leave approval and the attendance it produces must succeed or fail together
 * (plan section 56), so this always runs inside the caller's transaction.
 */
async function writeLeaveAttendance(
  auth: AuthContext,
  leaveRequestId: string,
  employeeId: string,
  leaveTypeId: string,
  dates: IsoDate[],
  dayPortion: string,
  tx: Queryable,
): Promise<void> {
  const status = dayPortion === 'HALF_DAY' ? 'HALF_DAY_LEAVE' : 'ON_LEAVE'

  for (const date of dates) {
    const existing = await attendanceRepository.findAttendanceForDate(employeeId, date, tx)
    if (existing?.locked_by_payroll_run_id) {
      throw ApiError.businessRule(
        `Attendance for ${date} is locked by a payroll run, so this leave cannot be approved. Raise a payroll adjustment instead.`,
      )
    }

    const row = await attendanceRepository.upsertAttendance(
      {
        organizationId: auth.organizationId,
        employeeId,
        attendanceDate: date,
        status,
        leaveRequestId,
        leaveTypeId,
        source: 'LEAVE_APPROVAL',
        remarks: 'Applied from approved leave',
        userId: auth.userId,
      },
      tx,
    )

    await attendanceRepository.recordAttendanceHistory(
      {
        attendanceId: row.id,
        organizationId: auth.organizationId,
        employeeId,
        attendanceDate: date,
        previousStatus: existing?.status ?? null,
        newStatus: status,
        reason: 'Leave approved',
        changedBy: auth.userId,
      },
      tx,
    )
  }
}

export async function approveLeaveRequest(
  auth: AuthContext,
  id: string,
  input: DecisionInput,
  context: AuditContext,
) {
  return withTransaction(async (tx) => {
    const request = await repository.findLeaveRequest(id, auth.organizationId, tx)
    if (!request) throw ApiError.notFound('Leave request')
    await assertEmployeeInScope(auth, request.employee_id, approveScope(auth), tx)

    if (request.status !== 'PENDING') {
      throw ApiError.businessRule(`This request is already ${request.status.toLowerCase()}`)
    }
    if (request.employee_id === auth.employeeId) {
      throw ApiError.forbidden('You cannot approve your own leave request')
    }

    const leaveType = await repository.findLeaveType(request.leave_type_id, auth.organizationId, tx)
    if (!leaveType) throw ApiError.notFound('Leave type')

    const employee = await loadEmployee(request.employee_id, auth.organizationId, tx)
    const breakdown = await computeLeaveDays(
      auth.organizationId,
      { id: employee.id, departmentId: employee.department_id, locationId: employee.location_id },
      leaveType,
      request.from_date,
      request.to_date,
      request.day_portion as 'FULL_DAY' | 'HALF_DAY',
      tx,
    )

    await writeLeaveAttendance(
      auth,
      request.id,
      request.employee_id,
      request.leave_type_id,
      breakdown.leaveDates,
      request.day_portion,
      tx,
    )

    const year = Number(request.from_date.slice(0, 4))
    const pendingDays = Number(request.total_days)
    // The recount is what was actually written: leave approved in between can
    // have sandwiched a holiday that was still free when this was applied for.
    const days = breakdown.totalDays
    // Move the days from pending to used.
    await repository.adjustBalance(
      request.employee_id,
      request.leave_type_id,
      year,
      { pending: -pendingDays, used: days },
      tx,
    )

    const updated = await repository.setLeaveRequestStatus(
      id,
      auth.organizationId,
      { status: 'APPROVED', decidedBy: auth.userId, decisionComment: input.comment ?? null, totalDays: days },
      tx,
    )

    await repository.insertApproval(
      {
        organizationId: auth.organizationId,
        leaveRequestId: id,
        approverUserId: auth.userId,
        approverEmployeeId: auth.employeeId,
        action: 'APPROVED',
        comment: input.comment ?? null,
      },
      tx,
    )

    await recordAudit(
      {
        ...context,
        action: 'LEAVE_APPROVED',
        entityType: 'leave_request',
        entityId: id,
        oldValues: { status: 'PENDING' },
        newValues: { status: 'APPROVED', days, attendanceDatesWritten: breakdown.leaveDates.length },
      },
      tx,
    )

    await notifyUserForEmployee(
      request.employee_id,
      {
        organizationId: auth.organizationId,
        type: 'LEAVE_REQUEST_APPROVED',
        title: 'Leave approved',
        body: `Your ${request.leave_type_name} request from ${request.from_date} to ${request.to_date} was approved.`,
        link: '/my-leave',
        metadata: { leaveRequestId: id },
      },
      tx,
    )

    return updated ? presentRequest({ ...request, ...updated } as repository.LeaveRequestWithDetailsRow) : null
  })
}

export async function rejectLeaveRequest(auth: AuthContext, id: string, input: RejectInput, context: AuditContext) {
  return withTransaction(async (tx) => {
    const request = await repository.findLeaveRequest(id, auth.organizationId, tx)
    if (!request) throw ApiError.notFound('Leave request')
    await assertEmployeeInScope(auth, request.employee_id, approveScope(auth), tx)

    if (request.status !== 'PENDING') {
      throw ApiError.businessRule(`This request is already ${request.status.toLowerCase()}`)
    }

    const year = Number(request.from_date.slice(0, 4))
    // Release the days that were held pending.
    await repository.adjustBalance(
      request.employee_id,
      request.leave_type_id,
      year,
      { pending: -Number(request.total_days) },
      tx,
    )

    const updated = await repository.setLeaveRequestStatus(
      id,
      auth.organizationId,
      { status: 'REJECTED', decidedBy: auth.userId, decisionComment: input.comment },
      tx,
    )

    await repository.insertApproval(
      {
        organizationId: auth.organizationId,
        leaveRequestId: id,
        approverUserId: auth.userId,
        approverEmployeeId: auth.employeeId,
        action: 'REJECTED',
        comment: input.comment,
      },
      tx,
    )

    await recordAudit(
      {
        ...context,
        action: 'LEAVE_REJECTED',
        entityType: 'leave_request',
        entityId: id,
        oldValues: { status: 'PENDING' },
        newValues: { status: 'REJECTED', comment: input.comment },
      },
      tx,
    )

    await notifyUserForEmployee(
      request.employee_id,
      {
        organizationId: auth.organizationId,
        type: 'LEAVE_REQUEST_REJECTED',
        title: 'Leave rejected',
        body: `Your ${request.leave_type_name} request was rejected: ${input.comment}`,
        link: '/my-leave',
        metadata: { leaveRequestId: id },
      },
      tx,
    )

    return updated ? presentRequest({ ...request, ...updated } as repository.LeaveRequestWithDetailsRow) : null
  })
}

export async function cancelLeaveRequest(auth: AuthContext, id: string, input: CancelInput, context: AuditContext) {
  return withTransaction(async (tx) => {
    const request = await repository.findLeaveRequest(id, auth.organizationId, tx)
    if (!request) throw ApiError.notFound('Leave request')

    const isOwner = request.employee_id === auth.employeeId
    if (!isOwner) {
      // Cancelling someone else's leave is an approver action.
      await assertEmployeeInScope(auth, request.employee_id, approveScope(auth), tx)
    }

    if (request.status === 'CANCELLED' || request.status === 'REJECTED') {
      throw ApiError.businessRule(`This request is already ${request.status.toLowerCase()}`)
    }

    const year = Number(request.from_date.slice(0, 4))
    const days = Number(request.total_days)

    if (request.status === 'PENDING') {
      await repository.adjustBalance(request.employee_id, request.leave_type_id, year, { pending: -days }, tx)
    } else if (request.status === 'APPROVED') {
      // Approved leave already wrote attendance; clear those days back so the
      // month stays consistent, unless payroll already consumed them. The rows
      // are found by the request that wrote them rather than by its from/to
      // range, because the sandwich rule can charge a holiday outside it.
      const written = await attendanceRepository.findAttendanceForLeaveRequest(request.id, tx)
      if (written.length > 0) {
        const employee = await loadEmployee(request.employee_id, auth.organizationId, tx)
        const marked = written.map((row) => row.attendance_date)
        const calendar = await buildCalendarContext(
          auth.organizationId,
          marked[0] ?? request.from_date,
          marked[marked.length - 1] ?? request.to_date,
          tx,
        )
        const scope = {
          departmentId: employee.department_id,
          locationId: employee.location_id,
          employeeId: employee.id,
        }

        for (const existing of written) {
          const date = existing.attendance_date
          if (existing.locked_by_payroll_run_id) {
            throw ApiError.businessRule(
              `Attendance for ${date} is locked by a payroll run, so this leave cannot be cancelled. Raise a payroll adjustment instead.`,
            )
          }
          // A day the sandwich rule took was a holiday before the leave claimed
          // it, so it goes back to being one rather than becoming an absence.
          const day = calendar.dayFor(date, scope)
          const status = day.kind === 'HOLIDAY' ? 'HOLIDAY' : day.kind === 'WEEKLY_OFF' ? 'WEEKLY_OFF' : 'ABSENT'

          const row = await attendanceRepository.upsertAttendance(
            {
              organizationId: auth.organizationId,
              employeeId: request.employee_id,
              attendanceDate: date,
              status,
              leaveRequestId: null,
              leaveTypeId: null,
              holidayId: day.kind === 'HOLIDAY' ? day.holidayId : null,
              source: 'LEAVE_APPROVAL',
              remarks: 'Leave cancelled',
              userId: auth.userId,
            },
            tx,
          )
          await attendanceRepository.recordAttendanceHistory(
            {
              attendanceId: row.id,
              organizationId: auth.organizationId,
              employeeId: request.employee_id,
              attendanceDate: date,
              previousStatus: existing.status,
              newStatus: status,
              reason: 'Leave cancelled',
              changedBy: auth.userId,
            },
            tx,
          )
        }
      }
      await repository.adjustBalance(request.employee_id, request.leave_type_id, year, { used: -days }, tx)
    }

    const updated = await repository.setLeaveRequestStatus(
      id,
      auth.organizationId,
      { status: 'CANCELLED', cancellationReason: input.reason ?? null },
      tx,
    )

    await recordAudit(
      {
        ...context,
        action: 'LEAVE_CANCELLED',
        entityType: 'leave_request',
        entityId: id,
        oldValues: { status: request.status },
        newValues: { status: 'CANCELLED', reason: input.reason ?? null },
      },
      tx,
    )

    await notifyUserForEmployee(
      request.employee_id,
      {
        organizationId: auth.organizationId,
        type: 'LEAVE_REQUEST_CANCELLED',
        title: 'Leave cancelled',
        body: `Your ${request.leave_type_name} request from ${request.from_date} to ${request.to_date} was cancelled.`,
        link: '/my-leave',
        metadata: { leaveRequestId: id },
      },
      tx,
    )

    return updated ? presentRequest({ ...request, ...updated } as repository.LeaveRequestWithDetailsRow) : null
  })
}

export async function countPendingForScope(auth: AuthContext): Promise<number> {
  const scope = viewScope(auth)
  const clause = scopeClause(auth, scope, 'e', 1)
  return repository.countPendingRequests(clause)
}
