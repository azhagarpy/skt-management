import { pool, queryOne, queryRows } from '../../database/pool.js'
import { ApiError } from '../../utils/api-error.js'
import { firstDayOfMonth, lastDayOfMonth, monthLabel, todayIso, type IsoDate } from '../../utils/dates.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { resolveScope, scopeClause } from '../employees/employee-access.js'
import * as employeeRepository from '../employees/employees.repository.js'
import { countPendingVerifications } from '../documents/documents.repository.js'
import { getProfileCompletion } from '../employees/employees.service.js'
import { countUnread } from '../notifications/notifications.service.js'
import type { AuthContext } from '../../types/express.js'

/**
 * Role-specific dashboards (plan sections 42, 43 and 44).
 *
 * Each dashboard answers only what its role is allowed to see: the Super Admin
 * gets organization-wide figures, a supervisor sees their team, and an employee
 * sees themselves.
 */

interface StatusCounts {
  present: number
  absent: number
  onLeave: number
  halfDay: number
  holiday: number
  weeklyOff: number
}

async function attendanceCountsForDate(
  auth: AuthContext,
  date: IsoDate,
  scope: 'ALL' | 'TEAM' | 'SELF',
): Promise<StatusCounts> {
  const clause = scopeClause(auth, scope, 'e', 1)
  const rows = await queryRows<{ status: string; count: string }>(
    pool,
    `SELECT a.status::text AS status, count(*)::text AS count
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
      WHERE (${clause.sql}) AND a.attendance_date = $${clause.params.length + 1}
      GROUP BY a.status`,
    [...clause.params, date],
  )

  const counts: StatusCounts = { present: 0, absent: 0, onLeave: 0, halfDay: 0, holiday: 0, weeklyOff: 0 }
  for (const row of rows) {
    if (row.status === 'PRESENT') counts.present = Number(row.count)
    else if (row.status === 'ABSENT') counts.absent = Number(row.count)
    else if (row.status === 'ON_LEAVE') counts.onLeave = Number(row.count)
    else if (row.status === 'HALF_DAY_LEAVE') counts.halfDay = Number(row.count)
    else if (row.status === 'HOLIDAY') counts.holiday = Number(row.count)
    else if (row.status === 'WEEKLY_OFF') counts.weeklyOff = Number(row.count)
  }
  return counts
}

async function pendingLeaveCount(auth: AuthContext, scope: 'ALL' | 'TEAM' | 'SELF'): Promise<number> {
  const clause = scopeClause(auth, scope, 'e', 1)
  const row = await queryOne<{ count: string }>(
    pool,
    `SELECT count(*)::text AS count
       FROM leave_requests r
       JOIN employees e ON e.id = r.employee_id
      WHERE (${clause.sql}) AND r.status = 'PENDING'`,
    clause.params,
  )
  return Number(row?.count ?? 0)
}

// ---------------------------------------------------------------------------
// Super Admin dashboard
// ---------------------------------------------------------------------------

export async function superAdminDashboard(auth: AuthContext) {
  const today = todayIso()
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))

  const [headcount, attendance, pendingLeave, payroll, pendingDocuments, incompleteProfiles, recentRuns] =
    await Promise.all([
      queryOne<{ total: string; active: string; supervisors: string; on_notice: string }>(
        pool,
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE employment_status = 'ACTIVE')::text AS active,
                count(*) FILTER (WHERE is_supervisor)::text AS supervisors,
                count(*) FILTER (WHERE employment_status = 'ON_NOTICE')::text AS on_notice
           FROM employees WHERE organization_id = $1`,
        [auth.organizationId],
      ),
      attendanceCountsForDate(auth, today, 'ALL'),
      pendingLeaveCount(auth, 'ALL'),
      queryOne<{
        id: string
        status: string
        total_gross: string
        total_net: string
        total_paid: string
        total_pending: string
        total_employees: string
      }>(
        pool,
        `SELECT id, status::text AS status, total_gross, total_net, total_paid, total_pending, total_employees::text
           FROM payroll_runs
          WHERE organization_id = $1 AND year = $2 AND month = $3`,
        [auth.organizationId, year, month],
      ),
      countPendingVerifications(auth.organizationId),
      employeeRepository.countIncompleteProfiles(auth.organizationId),
      queryRows<{
        id: string
        year: number
        month: number
        status: string
        total_net: string
        total_paid: string
        total_pending: string
      }>(
        pool,
        `SELECT id, year, month, status::text AS status, total_net, total_paid, total_pending
           FROM payroll_runs WHERE organization_id = $1 ORDER BY year DESC, month DESC LIMIT 6`,
        [auth.organizationId],
      ),
    ])

  // Payment split across the current month's payroll.
  const paymentSplit = payroll
    ? await queryRows<{ payment_status: string; count: string; amount: string }>(
        pool,
        `SELECT payment_status::text AS payment_status, count(*)::text AS count, coalesce(sum(net_salary), 0)::text AS amount
           FROM payroll_items WHERE payroll_run_id = $1 GROUP BY payment_status`,
        [payroll.id],
      )
    : []

  const byStatus: Record<string, { count: number; amount: number }> = {
    PENDING: { count: 0, amount: 0 },
    PARTIALLY_PAID: { count: 0, amount: 0 },
    PAID: { count: 0, amount: 0 },
  }
  for (const row of paymentSplit) {
    byStatus[row.payment_status] = { count: Number(row.count), amount: Number(row.amount) }
  }

  return {
    role: 'SUPER_ADMIN' as const,
    date: today,
    headcount: {
      totalEmployees: Number(headcount?.total ?? 0),
      activeEmployees: Number(headcount?.active ?? 0),
      supervisors: Number(headcount?.supervisors ?? 0),
      onNotice: Number(headcount?.on_notice ?? 0),
    },
    attendanceToday: attendance,
    pendingLeaveRequests: pendingLeave,
    documents: {
      pendingVerification: pendingDocuments,
      employeesWithIncompleteProfiles: incompleteProfiles,
    },
    currentPayroll: payroll
      ? {
          id: payroll.id,
          year,
          month,
          monthLabel: monthLabel(year, month),
          status: payroll.status,
          totalEmployees: Number(payroll.total_employees),
          grossSalary: Number(payroll.total_gross),
          netSalary: Number(payroll.total_net),
          paid: Number(payroll.total_paid),
          pending: Number(payroll.total_pending),
          byPaymentStatus: byStatus,
        }
      : null,
    recentPayrollRuns: recentRuns.map((run) => ({
      id: run.id,
      year: run.year,
      month: run.month,
      monthLabel: monthLabel(run.year, run.month),
      status: run.status,
      netSalary: Number(run.total_net),
      paid: Number(run.total_paid),
      pending: Number(run.total_pending),
    })),
  }
}

// ---------------------------------------------------------------------------
// Supervisor dashboard
// ---------------------------------------------------------------------------

export async function supervisorDashboard(auth: AuthContext) {
  if (!auth.employeeId) throw ApiError.businessRule('Your user account is not linked to an employee record')

  const today = todayIso()
  const clause = scopeClause(auth, 'TEAM', 'e', 1)

  const [team, attendance, pendingLeave, teamList] = await Promise.all([
    queryOne<{ total: string; active: string }>(
      pool,
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE e.employment_status = 'ACTIVE')::text AS active
         FROM employees e WHERE (${clause.sql})`,
      clause.params,
    ),
    attendanceCountsForDate(auth, today, 'TEAM'),
    pendingLeaveCount(auth, 'TEAM'),
    queryRows<{
      id: string
      employee_code: string
      first_name: string
      last_name: string | null
      designation_name: string | null
      status: string | null
    }>(
      pool,
      `SELECT e.id, e.employee_code, e.first_name, e.last_name,
              g.name AS designation_name,
              a.status::text AS status
         FROM employees e
         LEFT JOIN designations g ON g.id = e.designation_id
         LEFT JOIN attendance a ON a.employee_id = e.id AND a.attendance_date = $${clause.params.length + 1}
        WHERE (${clause.sql}) AND e.employment_status = 'ACTIVE'
        ORDER BY e.employee_code
        LIMIT 100`,
      [...clause.params, today],
    ),
  ])

  return {
    role: 'SUPERVISOR' as const,
    date: today,
    team: {
      totalEmployees: Number(team?.total ?? 0),
      activeEmployees: Number(team?.active ?? 0),
    },
    attendanceToday: attendance,
    pendingLeaveRequests: pendingLeave,
    teamMembers: teamList.map((member) => ({
      id: member.id,
      employeeCode: member.employee_code,
      name: [member.first_name, member.last_name].filter(Boolean).join(' '),
      designationName: member.designation_name,
      todayStatus: member.status,
    })),
  }
}

// ---------------------------------------------------------------------------
// Employee dashboard
// ---------------------------------------------------------------------------

export async function employeeDashboard(auth: AuthContext) {
  if (!auth.employeeId) throw ApiError.businessRule('Your user account is not linked to an employee record')

  const employeeId = auth.employeeId
  const today = todayIso()
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const monthStart = firstDayOfMonth(year, month)
  const monthEnd = lastDayOfMonth(year, month)

  const [todayAttendance, monthCounts, balances, pendingLeave, payrollItem, latestPayslip, completion, unread] =
    await Promise.all([
      queryOne<{ status: string }>(
        pool,
        'SELECT status::text AS status FROM attendance WHERE employee_id = $1 AND attendance_date = $2',
        [employeeId, today],
      ),
      queryRows<{ status: string; count: string }>(
        pool,
        `SELECT status::text AS status, count(*)::text AS count
           FROM attendance
          WHERE employee_id = $1 AND attendance_date BETWEEN $2 AND $3
          GROUP BY status`,
        [employeeId, monthStart, monthEnd],
      ),
      queryRows<{
        leave_type_name: string
        entitled: string
        used: string
        pending: string
        available: string
      }>(
        pool,
        `SELECT lt.name AS leave_type_name,
                (b.opening_balance + b.accrued + b.carried_forward + b.adjustment) AS entitled,
                b.used,
                b.pending,
                (b.opening_balance + b.accrued + b.carried_forward + b.adjustment - b.used - b.pending) AS available
           FROM employee_leave_balances b
           JOIN leave_types lt ON lt.id = b.leave_type_id
          WHERE b.employee_id = $1 AND b.leave_year = $2
          ORDER BY lt.name`,
        [employeeId, year],
      ),
      queryOne<{ count: string }>(
        pool,
        "SELECT count(*)::text AS count FROM leave_requests WHERE employee_id = $1 AND status = 'PENDING'",
        [employeeId],
      ),
      queryOne<{
        id: string
        net_salary: string
        paid_amount: string
        pending_amount: string
        payment_status: string
        year: number
        month: number
      }>(
        pool,
        `SELECT i.id, i.net_salary, i.paid_amount, i.pending_amount, i.payment_status::text AS payment_status,
                r.year, r.month
           FROM payroll_items i
           JOIN payroll_runs r ON r.id = i.payroll_run_id
          WHERE i.employee_id = $1 AND r.status IN ('APPROVED', 'LOCKED')
          ORDER BY r.year DESC, r.month DESC
          LIMIT 1`,
        [employeeId],
      ),
      queryOne<{ id: string; year: number; month: number; generated_at: Date }>(
        pool,
        `SELECT p.id, r.year, r.month, p.generated_at
           FROM payslips p
           JOIN payroll_items i ON i.id = p.payroll_item_id
           JOIN payroll_runs r ON r.id = i.payroll_run_id
          WHERE p.employee_id = $1
          ORDER BY r.year DESC, r.month DESC
          LIMIT 1`,
        [employeeId],
      ),
      getProfileCompletion(employeeId),
      countUnread(auth.userId),
    ])

  const counts: Record<string, number> = {}
  for (const row of monthCounts) counts[row.status] = Number(row.count)

  return {
    role: 'EMPLOYEE' as const,
    date: today,
    todayStatus: todayAttendance?.status ?? null,
    currentMonth: {
      year,
      month,
      monthLabel: monthLabel(year, month),
      present: counts.PRESENT ?? 0,
      absent: counts.ABSENT ?? 0,
      onLeave: counts.ON_LEAVE ?? 0,
      halfDay: counts.HALF_DAY_LEAVE ?? 0,
      holiday: counts.HOLIDAY ?? 0,
      weeklyOff: counts.WEEKLY_OFF ?? 0,
    },
    leaveBalances: balances.map((balance) => ({
      leaveTypeName: balance.leave_type_name,
      entitled: Number(balance.entitled),
      used: Number(balance.used),
      pending: Number(balance.pending),
      available: Number(balance.available),
    })),
    pendingLeaveRequests: Number(pendingLeave?.count ?? 0),
    latestPayroll: payrollItem
      ? {
          payrollItemId: payrollItem.id,
          year: payrollItem.year,
          month: payrollItem.month,
          monthLabel: monthLabel(payrollItem.year, payrollItem.month),
          netSalary: Number(payrollItem.net_salary),
          paidAmount: Number(payrollItem.paid_amount),
          pendingAmount: Number(payrollItem.pending_amount),
          paymentStatus: payrollItem.payment_status,
        }
      : null,
    latestPayslip: latestPayslip
      ? {
          id: latestPayslip.id,
          year: latestPayslip.year,
          month: latestPayslip.month,
          monthLabel: monthLabel(latestPayslip.year, latestPayslip.month),
          generatedAt: latestPayslip.generated_at,
          downloadPath: `/payslips/${latestPayslip.id}/file`,
        }
      : null,
    profileCompletion: completion,
    unreadNotifications: unread,
  }
}

/** Routes the caller to the dashboard their role is entitled to. */
export async function dashboardForRole(auth: AuthContext) {
  if (auth.has(PERMISSIONS.EMPLOYEE_VIEW_ALL)) return superAdminDashboard(auth)
  if (auth.has(PERMISSIONS.EMPLOYEE_VIEW_TEAM)) return supervisorDashboard(auth)
  // Referenced so the scope helper stays the single place role mapping lives.
  resolveScope(auth, { all: PERMISSIONS.EMPLOYEE_VIEW_ALL, team: PERMISSIONS.EMPLOYEE_VIEW_TEAM, self: PERMISSIONS.EMPLOYEE_VIEW_SELF })
  return employeeDashboard(auth)
}
