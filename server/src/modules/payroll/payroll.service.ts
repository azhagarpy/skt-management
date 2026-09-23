import { ApiError } from '../../utils/api-error.js'
import { withAdvisoryLock, withTransaction, type TxClient } from '../../database/tx.js'
import { buildPaginated, type Paginated } from '../../utils/pagination.js'
import {
  datesBetween,
  monthLabel,
  payCycleFor,
  PAYROLL_CYCLE_CUTOFF_DAY,
  type IsoDate,
} from '../../utils/dates.js'
import { toMajor, toMinor, toNumericString } from '../../utils/money.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { assertEmployeeInScope, resolveScope, scopeClause } from '../employees/employee-access.js'
import { buildCalendarContext } from '../calendar/calendar.service.js'
import * as attendanceRepository from '../attendance/attendance.repository.js'
import * as leaveRepository from '../leave/leave.repository.js'
import * as salaryRepository from '../salary/salary.repository.js'
import * as overtimeRepository from '../overtime/overtime.repository.js'
import { listApprovedBonusesForPeriod } from '../bonuses/bonuses.module.js'
import { listTaxDeductionsForPeriod } from '../tax/tax.module.js'
import { listLwfForPeriod } from '../lwf/lwf.module.js'
import { listApprovedPlWagesForPeriod } from '../pl-wages/pl-wages.module.js'
import { notifyRole, notifyUserForEmployee } from '../notifications/notifications.service.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './payroll.repository.js'
import {
  calculatePayrollItem,
  type AdjustmentInput,
  type TaxInput,
  type LwfInput,
  type PlWagesInput,
  type AttendanceStatus,
  type BonusInput,
  type CalculatorInput,
  type CalculatorOutput,
  type ComponentInput,
  type DayInput,
  type PolicyInput,
} from './payroll.calculator.js'
import type {
  CreateRunInput,
  RunListQuery,
  ItemListQuery,
  AdjustmentCreateInput,
  UpdateRunPeriodInput,
} from './payroll.validation.js'

/**
 * Fixed defaults for how paid days and half days are valued. This used to be
 * a per-organization payroll policy; it is now the same for everyone, which
 * is what "remove the complex logic from the salary module" means in practice.
 *
 * A weekly off is not paid: the day is counted in the calendar-day basis (the
 * denominator) but earns nothing, so pay follows the days actually worked.
 * Holidays stay paid, which is what makes the sandwich rule in leave.service.ts
 * worth anything - a holiday charged as leave is a paid day turned into one
 * that costs the employee a day of balance.
 */
const DEFAULT_POLICY: PolicyInput = {
  paidDaysBasis: 'CALENDAR_DAYS',
  halfDayPaidFraction: 1,
  halfDayUnpaidFraction: 0.5,
  countHolidaysAsPaid: true,
  countWeeklyOffAsPaid: false,
  prorateOnJoining: true,
  prorateOnExit: true,
  netRoundingDecimals: 2,
}

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

export function presentRun(row: repository.PayrollRunRow) {
  return {
    id: row.id,
    year: row.year,
    month: row.month,
    monthLabel: monthLabel(row.year, row.month),
    name: row.name,
    status: row.status,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    totalEmployees: row.total_employees,
    totalGross: Number(row.total_gross),
    totalDeductions: Number(row.total_deductions),
    totalNet: Number(row.total_net),
    totalPaid: Number(row.total_paid),
    totalPending: Number(row.total_pending),
    notes: row.notes,
    createdByName: row.created_by_name ?? null,
    approvedByName: row.approved_by_name ?? null,
    createdAt: row.created_at,
    calculatedAt: row.calculated_at,
    approvedAt: row.approved_at,
    lockedAt: row.locked_at,
    isEditable: row.status === 'DRAFT' || row.status === 'CALCULATED' || row.status === 'UNDER_REVIEW',
    isLocked: row.status === 'LOCKED',
  }
}

export function presentItem(row: repository.PayrollItemRow) {
  return {
    id: row.id,
    payrollRunId: row.payroll_run_id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    departmentName: row.department_name,
    designationName: row.designation_name,
    supervisorName: row.supervisor_name,
    salaryBasis: row.salary_basis,
    salaryStructureName: row.salary_structure_name,
    attendance: {
      calendarDays: Number(row.calendar_days),
      workingDays: Number(row.working_days),
      presentDays: Number(row.present_days),
      absentDays: Number(row.absent_days),
      leaveDays: Number(row.leave_days),
      paidLeaveDays: Number(row.paid_leave_days),
      unpaidLeaveDays: Number(row.unpaid_leave_days),
      halfDayLeaveDays: Number(row.half_day_leave_days),
      holidayDays: Number(row.holiday_days),
      weeklyOffDays: Number(row.weekly_off_days),
      unmarkedDays: Number(row.unmarked_days),
      paidDays: Number(row.paid_days),
      payableDaysBasis: Number(row.payable_days_basis),
    },
    grossEarnings: Number(row.gross_earnings),
    totalBonus: Number(row.total_bonus),
    totalDeductions: Number(row.total_deductions),
    employerContributions: Number(row.employer_contributions),
    pfWage: Number(row.pf_wage),
    pfWageCeiling: Number(row.pf_wage_ceiling),
    esiWage: Number(row.esi_wage),
    netSalary: Number(row.net_salary),
    paidAmount: Number(row.paid_amount),
    pendingAmount: Number(row.pending_amount),
    paymentStatus: row.payment_status,
    remarks: row.remarks,
    runStatus: row.run_status ?? null,
    runYear: row.run_year ?? null,
    runMonth: row.run_month ?? null,
    contributions: presentContributions(row),
  }
}

/**
 * PF and ESI split out of the deductions and employer contributions, for the
 * run's item table. Only present where the query summed the components; other
 * callers (payroll history, item detail) read the full component list instead.
 * `otherDeductions` is whatever the total deductions hold besides PF and ESI.
 */
function presentContributions(row: repository.PayrollItemRow) {
  if (row.pf_employee === undefined) return undefined
  const pfEmployee = Number(row.pf_employee)
  const esiEmployee = Number(row.esi_employee)
  const pfEmployerEpf = Number(row.pf_employer_epf)
  const pfEmployerEps = Number(row.pf_employer_eps)
  return {
    pfEmployee,
    esiEmployee,
    otherDeductions: Math.max(0, Math.round((Number(row.total_deductions) - pfEmployee - esiEmployee) * 100) / 100),
    pfEmployerEpf,
    pfEmployerEps,
    pfEmployer: Math.round((pfEmployerEpf + pfEmployerEps) * 100) / 100,
    esiEmployer: Number(row.esi_employer),
  }
}

export function presentComponent(row: repository.PayrollItemComponentRow) {
  return {
    id: row.id,
    code: row.component_code,
    name: row.component_name,
    componentType: row.component_type,
    calculationType: row.calculation_type,
    source: row.source,
    fullAmount: Number(row.full_amount),
    amount: Number(row.amount),
    percentage: row.percentage === null ? null : Number(row.percentage),
    taxable: row.taxable,
    displayOrder: row.display_order,
    notes: row.notes,
  }
}

// ---------------------------------------------------------------------------
// Input assembly
// ---------------------------------------------------------------------------

export function toComponentInputs(structure: salaryRepository.SalaryStructureWithComponents): ComponentInput[] {
  return structure.components.map((component) => ({
    code: component.code,
    name: component.name,
    componentType: component.component_type,
    calculationType: component.calculation_type,
    amountMinor: toMinor(component.amount),
    percentage: Number(component.percentage),
    percentageBase: (component.percentage_base as ComponentInput['percentageBase']) ?? null,
    baseComponentCode: component.base_component_code,
    taxable: component.taxable,
    prorate: component.prorate,
    displayOrder: component.display_order,
  }))
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function listRuns(auth: AuthContext, filters: RunListQuery) {
  const { rows, total } = await repository.listRuns(auth.organizationId, filters)
  return buildPaginated(rows.map(presentRun), total, filters.page, filters.pageSize)
}

export async function getRun(auth: AuthContext, id: string) {
  const row = await repository.findRun(id, auth.organizationId)
  if (!row) throw ApiError.notFound('Payroll run')
  return presentRun(row)
}

export async function createRun(auth: AuthContext, input: CreateRunInput, context: AuditContext) {
  const existing = await repository.findRunByPeriod(auth.organizationId, input.year, input.month)
  if (existing) {
    throw ApiError.conflict(`A payroll run already exists for ${monthLabel(input.year, input.month)}`)
  }

  // The standard cycle is the 21st of the previous month through the 20th of the
  // named month; the dates can be changed when the run is created or afterwards.
  const standard = payCycleFor(input.year, input.month, PAYROLL_CYCLE_CUTOFF_DAY)
  const periodStart = input.periodStart ?? standard.start
  const periodEnd = input.periodEnd ?? standard.end
  await assertNoOverlap(auth.organizationId, periodStart, periodEnd, null)

  const row = await repository.insertRun({
    organization_id: auth.organizationId,
    year: input.year,
    month: input.month,
    name: input.name ?? `${monthLabel(input.year, input.month)} Payroll`,
    period_start: periodStart,
    period_end: periodEnd,
    notes: input.notes ?? null,
    created_by: auth.userId,
  })

  await recordAudit({
    ...context,
    action: 'PAYROLL_RUN_CREATED',
    entityType: 'payroll_run',
    entityId: row.id,
    newValues: { year: input.year, month: input.month, periodStart, periodEnd },
  })

  return presentRun(row)
}

/**
 * Two runs covering the same day would pay that day twice, so a period may not
 * overlap another run's.
 */
async function assertNoOverlap(
  organizationId: string,
  start: IsoDate,
  end: IsoDate,
  excludeRunId: string | null,
): Promise<void> {
  const clash = await repository.findOverlappingRun(organizationId, start, end, excludeRunId)
  if (clash) {
    throw ApiError.conflict(
      `These dates overlap the ${monthLabel(clash.year, clash.month)} payroll (${clash.period_start} to ${clash.period_end}). Two runs cannot cover the same day.`,
    )
  }
}

/**
 * Changes the dates a run covers.
 *
 * Allowed until the run is approved. A run that was already calculated no longer
 * matches its dates, so it goes back to DRAFT and has to be calculated again
 * before it can be reviewed - the old figures stay visible until then.
 */
export async function updateRunPeriod(
  auth: AuthContext,
  runId: string,
  input: UpdateRunPeriodInput,
  context: AuditContext,
) {
  const run = await repository.findRun(runId, auth.organizationId)
  if (!run) throw ApiError.notFound('Payroll run')

  if (run.status === 'APPROVED' || run.status === 'LOCKED') {
    throw ApiError.payroll(
      `This payroll run is ${run.status.toLowerCase()}, so its dates can no longer be changed. Raise an adjustment instead.`,
    )
  }
  if (input.periodStart === run.period_start && input.periodEnd === run.period_end) return presentRun(run)

  await assertNoOverlap(auth.organizationId, input.periodStart, input.periodEnd, runId)

  const updated = await repository.updateRun(runId, auth.organizationId, {
    period_start: input.periodStart,
    period_end: input.periodEnd,
    status: 'DRAFT',
  })
  if (!updated) throw ApiError.notFound('Payroll run')

  await recordAudit({
    ...context,
    action: 'PAYROLL_RUN_UPDATED',
    entityType: 'payroll_run',
    entityId: runId,
    oldValues: { periodStart: run.period_start, periodEnd: run.period_end, status: run.status },
    newValues: { periodStart: input.periodStart, periodEnd: input.periodEnd, status: 'DRAFT' },
  })

  return presentRun(updated)
}

export interface CalculationSummary {
  run: ReturnType<typeof presentRun>
  employeesProcessed: number
  skipped: { employeeId: string; employeeCode: string; reason: string }[]
  warnings: { employeeCode: string; warnings: string[] }[]
}

/**
 * Calculates every payroll item in the run.
 *
 * The whole calculation is one transaction (plan section 56): either the run is
 * fully recalculated or nothing changes. Recalculating a DRAFT or CALCULATED run
 * discards the previous items first, so repeating the operation is safe.
 *
 * All input for the period is loaded in a handful of batch queries rather than
 * per employee, which is what keeps a 250-person payroll off the N+1 path
 * (plan section 59).
 */
export async function calculateRun(
  auth: AuthContext,
  runId: string,
  context: AuditContext,
): Promise<CalculationSummary> {
  return withTransaction(async (tx) => {
    // Serialise concurrent calculations of the same run.
    return withAdvisoryLock(tx, `payroll-run:${runId}`, async () => {
      const run = await repository.findRunForUpdate(runId, auth.organizationId, tx)
      if (!run) throw ApiError.notFound('Payroll run')

      if (run.status === 'APPROVED' || run.status === 'LOCKED') {
        throw ApiError.payroll(
          `This payroll run is ${run.status.toLowerCase()} and can no longer be recalculated. Raise an adjustment instead.`,
        )
      }

      const periodStart = run.period_start
      const periodEnd = run.period_end

      // --- Load everything the calculator needs, in batches. ----------------
      const employees = await repository.listEmployeesForPeriod(auth.organizationId, periodStart, periodEnd, tx)
      if (employees.length === 0) {
        throw ApiError.payroll('There are no active employees for this payroll period')
      }
      const employeeIds = employees.map((employee) => employee.id)

      const policy = DEFAULT_POLICY

      const [calendar, attendanceRows, leaveRows, assignments, bonuses, taxDeductions, lwfContributions, plWagesCredits, adjustments, overtimeHoursByEmployee] =
        await Promise.all([
          buildCalendarContext(auth.organizationId, periodStart, periodEnd, tx),
          attendanceRepository.listAttendanceForEmployees(employeeIds, periodStart, periodEnd, tx),
          leaveRepository.listApprovedLeaveForPeriod(employeeIds, periodStart, periodEnd, tx),
          salaryRepository.findAssignmentsForDate(employeeIds, periodEnd, tx),
          listApprovedBonusesForPeriod(employeeIds, run.year, run.month, tx),
          listTaxDeductionsForPeriod(employeeIds, run.year, run.month, tx),
          listLwfForPeriod(employeeIds, run.year, run.month, tx),
          listApprovedPlWagesForPeriod(employeeIds, run.year, run.month, tx),
          repository.listPendingAdjustments(auth.organizationId, run.year, run.month, employeeIds, tx),
          overtimeRepository.sumOvertimeHours(employeeIds, periodStart, periodEnd, tx),
        ])

      // Structures are shared, so each distinct one is fetched once.
      const structureCache = new Map<string, salaryRepository.SalaryStructureWithComponents>()
      for (const assignment of assignments) {
        if (structureCache.has(assignment.salary_structure_id)) continue
        const structure = await salaryRepository.findStructure(
          assignment.salary_structure_id,
          auth.organizationId,
          tx,
        )
        if (structure) structureCache.set(assignment.salary_structure_id, structure)
      }

      // --- Index the loaded data by employee. -------------------------------
      const assignmentByEmployee = new Map(assignments.map((row) => [row.employee_id, row]))

      const attendanceByEmployee = new Map<string, Map<IsoDate, attendanceRepository.AttendanceRow>>()
      for (const row of attendanceRows) {
        const byDate = attendanceByEmployee.get(row.employee_id) ?? new Map()
        byDate.set(row.attendance_date, row)
        attendanceByEmployee.set(row.employee_id, byDate)
      }

      // Leave paid/unpaid per date, so the calculator can value each leave day.
      const leavePaidByEmployeeDate = new Map<string, Map<IsoDate, boolean>>()
      for (const leave of leaveRows) {
        const byDate = leavePaidByEmployeeDate.get(leave.employee_id) ?? new Map()
        for (const date of datesBetween(periodStart, periodEnd)) {
          if (date >= leave.from_date && date <= leave.to_date) byDate.set(date, leave.is_paid)
        }
        leavePaidByEmployeeDate.set(leave.employee_id, byDate)
      }

      const bonusesByEmployee = new Map<string, BonusInput[]>()
      for (const bonus of bonuses) {
        const list = bonusesByEmployee.get(bonus.employee_id) ?? []
        list.push({
          id: bonus.id,
          code: 'BONUS',
          name: bonus.bonus_name,
          amountType: bonus.amount_type,
          amountMinor: toMinor(bonus.amount),
          percentage: Number(bonus.percentage),
          taxable: true,
        })
        bonusesByEmployee.set(bonus.employee_id, list)
      }

      const taxByEmployee = new Map<string, TaxInput>()
      for (const entry of taxDeductions) {
        taxByEmployee.set(entry.employee_id, {
          id: entry.id,
          amountMinor: toMinor(entry.tax_amount),
          note: `On wages ${entry.wage_base} for ${entry.period_from} to ${entry.period_to}`,
        })
      }

      const lwfByEmployee = new Map<string, LwfInput>()
      for (const entry of lwfContributions) {
        lwfByEmployee.set(entry.employee_id, {
          id: entry.id,
          amountMinor: toMinor(entry.employee_amount),
          note: `Labour Welfare Fund for ${entry.contribution_year}`,
        })
      }

      const plWagesByEmployee = new Map<string, PlWagesInput>()
      for (const entry of plWagesCredits) {
        plWagesByEmployee.set(entry.employee_id, {
          id: entry.id,
          amountMinor: toMinor(entry.credit_amount),
          note: `PL Wages for ${entry.credit_year} (${entry.eligible_days} day(s) at ${entry.daily_wage_rate}/day)`,
        })
      }

      const adjustmentsByEmployee = new Map<string, AdjustmentInput[]>()
      for (const adjustment of adjustments) {
        const list = adjustmentsByEmployee.get(adjustment.employee_id) ?? []
        list.push({
          id: adjustment.id,
          code: adjustment.component_code,
          name: adjustment.component_name,
          componentType: adjustment.component_type,
          amountMinor: toMinor(adjustment.amount),
          reason: adjustment.reason,
        })
        adjustmentsByEmployee.set(adjustment.employee_id, list)
      }

      // --- Replace any previous calculation. --------------------------------
      await repository.clearAppliedAdjustmentsForRun(runId, tx)
      await repository.deleteRunItems(runId, tx)

      const periodDates = datesBetween(periodStart, periodEnd)
      const skipped: CalculationSummary['skipped'] = []
      const warnings: CalculationSummary['warnings'] = []
      const appliedAdjustmentIds: string[] = []
      const itemIdByAdjustment = new Map<string, string>()
      let processed = 0

      for (const employee of employees) {
        const assignment = assignmentByEmployee.get(employee.id)
        if (!assignment) {
          skipped.push({
            employeeId: employee.id,
            employeeCode: employee.employee_code,
            reason: 'No salary structure is effective for this period',
          })
          continue
        }

        const structure = structureCache.get(assignment.salary_structure_id)
        if (!structure) {
          skipped.push({
            employeeId: employee.id,
            employeeCode: employee.employee_code,
            reason: 'The assigned salary structure could not be loaded',
          })
          continue
        }

        const attendanceByDate = attendanceByEmployee.get(employee.id) ?? new Map()
        const leaveByDate = leavePaidByEmployeeDate.get(employee.id) ?? new Map()
        const scope = { departmentId: employee.department_id, locationId: employee.location_id, employeeId: employee.id }

        const days: DayInput[] = periodDates.map((date) => {
          const calendarDay = calendar.dayFor(date, scope)
          const record = attendanceByDate.get(date)

          // Employment window, honouring the policy's proration switches: when
          // proration is off, the full month is treated as employed.
          const beforeJoining = date < employee.joining_date
          const afterExit = employee.exit_date !== null && date > employee.exit_date
          const isEmployed =
            (!beforeJoining || !policy.prorateOnJoining) && (!afterExit || !policy.prorateOnExit)

          const status = (record?.status as AttendanceStatus | undefined) ?? null
          const leaveIsPaid =
            status === 'ON_LEAVE' || status === 'HALF_DAY_LEAVE' ? (leaveByDate.get(date) ?? false) : null

          return {
            date,
            dayKind: calendarDay.kind,
            status,
            leaveIsPaid,
            isEmployed,
            holidayExtraPay: calendarDay.holidayExtraPay,
            holidayName: calendarDay.holidayName,
          }
        })

        const employeeAdjustments = adjustmentsByEmployee.get(employee.id) ?? []

        // PSR overtime is paid; Supply overtime converts to extra weekly offs
        // instead (overtime.service.ts) and never reaches payroll at all. There
        // is no organization-wide default rate: it is set per employee.
        let overtime: CalculatorInput['overtime'] = null
        if (employee.employee_type === 'PSR') {
          const hours = overtimeHoursByEmployee.get(employee.id) ?? 0
          const rateMinor = employee.overtime_rate_override_minor ?? null
          if (hours > 0) {
            if (rateMinor === null) {
              warnings.push({
                employeeCode: employee.employee_code,
                warnings: ['Overtime hours are recorded but no PSR overtime rate is configured; overtime was not paid.'],
              })
            } else {
              overtime = { hours, rateMinor }
            }
          }
        }

        const calculatorInput: CalculatorInput = {
          period: { year: run.year, month: run.month, start: periodStart, end: periodEnd },
          employee: {
            id: employee.id,
            code: employee.employee_code,
            name: [employee.first_name, employee.middle_name, employee.last_name].filter(Boolean).join(' '),
            salaryBasis: structure.salary_basis,
          },
          days,
          components: toComponentInputs(structure),
          overrideTotalMinor: assignment.override_amount === null ? null : toMinor(assignment.override_amount),
          overtime,
          bonuses: bonusesByEmployee.get(employee.id) ?? [],
          tax: taxByEmployee.get(employee.id) ?? null,
          lwf: lwfByEmployee.get(employee.id) ?? null,
          plWages: plWagesByEmployee.get(employee.id) ?? null,
          adjustments: employeeAdjustments,
          // PF and ESI rates, and their wage ceiling/limit, live on the salary
          // structure now, not on the employee or a separate statutory rule;
          // only whether the employee is enrolled at all stays a per-employee flag.
          pf: {
            applicable: employee.pf_applicable ?? false,
            employeeRate: Number(structure.pf_employee_rate),
            employerRate: Number(structure.pf_employer_rate),
            wageLimitMinor: toMinor(structure.pf_wage_ceiling),
            epsRate: Number(structure.pf_eps_rate),
          },
          esi: {
            applicable: employee.esi_applicable ?? false,
            employeeRate: Number(structure.esi_employee_rate),
            employerRate: Number(structure.esi_employer_rate),
            wageLimitMinor: toMinor(structure.esi_wage_limit),
          },
          policy,
        }

        const result: CalculatorOutput = calculatePayrollItem(calculatorInput)

        if (result.warnings.length > 0) {
          warnings.push({ employeeCode: employee.employee_code, warnings: result.warnings })
        }

        const item = await repository.insertItem(
          {
            organization_id: auth.organizationId,
            payroll_run_id: runId,
            employee_id: employee.id,
            employee_code: employee.employee_code,
            employee_name: calculatorInput.employee.name,
            department_name: employee.department_name,
            designation_name: employee.designation_name,
            supervisor_name: employee.supervisor_name,
            salary_basis: structure.salary_basis,
            salary_structure_id: structure.id,
            salary_structure_name: structure.name,
            salary_assignment_id: assignment.id,
            calendar_days: result.attendance.calendarDays,
            working_days: result.attendance.workingDays,
            present_days: result.attendance.presentDays,
            absent_days: result.attendance.absentDays,
            leave_days: result.attendance.leaveDays,
            paid_leave_days: result.attendance.paidLeaveDays,
            unpaid_leave_days: result.attendance.unpaidLeaveDays,
            half_day_leave_days: result.attendance.halfDayLeaveDays,
            holiday_days: result.attendance.holidayDays,
            weekly_off_days: result.attendance.weeklyOffDays,
            unmarked_days: result.attendance.unmarkedDays,
            paid_days: result.attendance.paidDays,
            payable_days_basis: result.attendance.payableDaysBasis,
            gross_earnings: toNumericString(result.grossEarningsMinor),
            total_bonus: toNumericString(result.totalBonusMinor),
            total_deductions: toNumericString(result.totalDeductionsMinor),
            employer_contributions: toNumericString(result.employerContributionsMinor),
            pf_wage: toNumericString(result.pfWageMinor),
            pf_wage_ceiling: toNumericString(result.pfWageCeilingMinor),
            esi_wage: toNumericString(result.esiWageMinor),
            net_salary: toNumericString(result.netSalaryMinor),
            paid_amount: '0',
            // Nothing is payable when the net is zero (or negative), so the item is
            // settled from the start rather than left pending forever.
            pending_amount: toNumericString(Math.max(result.netSalaryMinor, 0)),
            payment_status: result.netSalaryMinor <= 0 ? 'PAID' : 'PENDING',
            remarks: result.warnings.length > 0 ? result.warnings.join(' ') : null,
            // The snapshot explains the run later, without re-deriving anything.
            calculation_snapshot: {
              policy,
              statutory: {
                pf: calculatorInput.pf,
                esi: calculatorInput.esi,
              },
              assignment: {
                id: assignment.id,
                structureId: assignment.salary_structure_id,
                effectiveFrom: assignment.effective_from,
                overrideAmount: assignment.override_amount,
              },
              days,
              warnings: result.warnings,
              calculatedAt: new Date().toISOString(),
            },
          },
          tx,
        )

        await repository.insertItemComponents(
          auth.organizationId,
          item.id,
          result.components.map((component) => ({
            code: component.code,
            name: component.name,
            componentType: component.componentType,
            calculationType: component.calculationType,
            source: component.source,
            fullAmount: toNumericString(component.fullAmountMinor),
            amount: toNumericString(component.amountMinor),
            percentage: component.percentage,
            taxable: component.taxable,
            displayOrder: component.displayOrder,
            referenceId: component.referenceId,
            notes: component.notes,
          })),
          tx,
        )

        for (const adjustment of employeeAdjustments) {
          appliedAdjustmentIds.push(adjustment.id)
          itemIdByAdjustment.set(adjustment.id, item.id)
        }

        processed += 1
      }

      if (processed === 0) {
        throw ApiError.payroll(
          'No payroll items could be calculated. Check that employees have an effective salary assignment.',
        )
      }

      await repository.markAdjustmentsApplied(appliedAdjustmentIds, itemIdByAdjustment, tx)
      await repository.refreshRunTotals(runId, tx)

      const updated = await repository.updateRun(
        runId,
        auth.organizationId,
        { status: 'CALCULATED', calculated_at: new Date(), calculated_by: auth.userId },
        tx,
      )

      await recordAudit(
        {
          ...context,
          action: 'PAYROLL_CALCULATED',
          entityType: 'payroll_run',
          entityId: runId,
          newValues: {
            employeesProcessed: processed,
            skipped: skipped.length,
            totalNet: updated ? Number(updated.total_net) : null,
          },
        },
        tx,
      )

      return {
        run: presentRun(updated as repository.PayrollRunRow),
        employeesProcessed: processed,
        skipped,
        warnings,
      }
    })
  })
}

/** Deletes a run that was created but never calculated - nothing downstream depends on it yet. */
export async function deleteRun(auth: AuthContext, runId: string, context: AuditContext) {
  const run = await repository.findRun(runId, auth.organizationId)
  if (!run) throw ApiError.notFound('Payroll run')

  if (run.status !== 'DRAFT') {
    throw ApiError.payroll(
      `This payroll run is ${run.status.toLowerCase()} and has already been processed. Only a draft run that has not been calculated can be removed.`,
    )
  }

  await repository.deleteRun(runId, auth.organizationId)

  await recordAudit({
    ...context,
    action: 'PAYROLL_RUN_DELETED',
    entityType: 'payroll_run',
    entityId: runId,
    oldValues: { year: run.year, month: run.month, status: run.status },
  })

  return { id: runId }
}

/** Moves a calculated run into review. */
export async function submitForReview(auth: AuthContext, runId: string, context: AuditContext) {
  const run = await repository.findRun(runId, auth.organizationId)
  if (!run) throw ApiError.notFound('Payroll run')
  if (run.status !== 'CALCULATED') {
    throw ApiError.payroll('Only a calculated payroll run can be submitted for review')
  }

  const updated = await repository.updateRun(runId, auth.organizationId, { status: 'UNDER_REVIEW' })
  await recordAudit({
    ...context,
    action: 'PAYROLL_SUBMITTED_FOR_REVIEW',
    entityType: 'payroll_run',
    entityId: runId,
  })
  return presentRun(updated as repository.PayrollRunRow)
}

export async function approveRun(auth: AuthContext, runId: string, context: AuditContext) {
  return withTransaction(async (tx) => {
    const run = await repository.findRunForUpdate(runId, auth.organizationId, tx)
    if (!run) throw ApiError.notFound('Payroll run')

    if (run.status !== 'CALCULATED' && run.status !== 'UNDER_REVIEW') {
      throw ApiError.payroll(`A payroll run in ${run.status} status cannot be approved`)
    }
    if (run.total_employees === 0) {
      throw ApiError.payroll('This payroll run has no items to approve')
    }

    const updated = await repository.updateRun(
      runId,
      auth.organizationId,
      { status: 'APPROVED', approved_at: new Date(), approved_by: auth.userId },
      tx,
    )

    await recordAudit(
      {
        ...context,
        action: 'PAYROLL_APPROVED',
        entityType: 'payroll_run',
        entityId: runId,
        oldValues: { status: run.status },
        newValues: { status: 'APPROVED', totalNet: Number(run.total_net) },
      },
      tx,
    )

    await notifyRole(
      auth.organizationId,
      ['SUPER_ADMIN'],
      {
        organizationId: auth.organizationId,
        type: 'PAYROLL_APPROVED',
        title: 'Payroll approved',
        body: `${monthLabel(run.year, run.month)} payroll has been approved.`,
        link: `/payroll/runs/${runId}`,
      },
      tx,
    )

    return presentRun(updated as repository.PayrollRunRow)
  })
}

/**
 * Locks the run and the attendance it consumed.
 *
 * After this, salary, components, attendance, and bonuses for the
 * period are read-only; corrections go through an adjustment (plan section 33).
 */
export async function lockRun(auth: AuthContext, runId: string, context: AuditContext) {
  return withTransaction(async (tx) => {
    const run = await repository.findRunForUpdate(runId, auth.organizationId, tx)
    if (!run) throw ApiError.notFound('Payroll run')
    if (run.status !== 'APPROVED') {
      throw ApiError.payroll('Only an approved payroll run can be locked')
    }

    const lockedRows = await attendanceRepository.lockAttendanceForPeriod(
      auth.organizationId,
      runId,
      run.period_start,
      run.period_end,
      tx,
    )
    await overtimeRepository.lockOvertimeForPeriod(auth.organizationId, runId, run.period_start, run.period_end, tx)

    const updated = await repository.updateRun(
      runId,
      auth.organizationId,
      { status: 'LOCKED', locked_at: new Date(), locked_by: auth.userId },
      tx,
    )

    await recordAudit(
      {
        ...context,
        action: 'PAYROLL_LOCKED',
        entityType: 'payroll_run',
        entityId: runId,
        oldValues: { status: 'APPROVED' },
        newValues: { status: 'LOCKED', attendanceRowsLocked: lockedRows },
      },
      tx,
    )

    return presentRun(updated as repository.PayrollRunRow)
  })
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function listItems(
  auth: AuthContext,
  runId: string,
  filters: ItemListQuery,
): Promise<Paginated<ReturnType<typeof presentItem>>> {
  const run = await repository.findRun(runId, auth.organizationId)
  if (!run) throw ApiError.notFound('Payroll run')

  // A supervisor with team payroll access sees only their team's items.
  if (!auth.has(PERMISSIONS.PAYROLL_VIEW_ALL)) {
    const scope = resolveScope(auth, {
      all: PERMISSIONS.PAYROLL_VIEW_ALL,
      team: PERMISSIONS.PAYROLL_VIEW_TEAM,
      self: PERMISSIONS.PAYROLL_VIEW_SELF,
    })
    const clause = scopeClause(auth, scope, 'e', 1)
    const rows = await repository.listItemsForScope(clause, runId)
    return buildPaginated(rows.map(presentItem), rows.length, 1, Math.max(rows.length, 1))
  }

  const { rows, total } = await repository.listItems(runId, auth.organizationId, filters)
  return buildPaginated(rows.map(presentItem), total, filters.page, filters.pageSize)
}

export async function getItem(auth: AuthContext, itemId: string) {
  const item = await repository.findItem(itemId, auth.organizationId)
  if (!item) throw ApiError.notFound('Payroll item')

  const scope = resolveScope(auth, {
    all: PERMISSIONS.PAYROLL_VIEW_ALL,
    team: PERMISSIONS.PAYROLL_VIEW_TEAM,
    self: PERMISSIONS.PAYROLL_VIEW_SELF,
  })
  await assertEmployeeInScope(auth, item.employee_id, scope)

  // An employee must not see their own figures before the run is approved.
  if (scope === 'SELF' && item.run_status !== 'APPROVED' && item.run_status !== 'LOCKED') {
    throw ApiError.forbidden('This payroll has not been published yet')
  }

  const components = await repository.listItemComponents(itemId)

  return {
    ...presentItem(item),
    components: components.map(presentComponent),
    earnings: components.filter((component) => component.component_type === 'EARNING').map(presentComponent),
    deductions: components.filter((component) => component.component_type === 'DEDUCTION').map(presentComponent),
    // Named distinctly from the numeric total on the item itself.
    employerContributionComponents: components
      .filter((component) => component.component_type === 'EMPLOYER_CONTRIBUTION')
      .map(presentComponent),
  }
}

/** An employee's own payroll history, used by the employee dashboard. */
export async function listMyPayroll(auth: AuthContext, employeeId: string, year: number | undefined, limit: number) {
  const scope = resolveScope(auth, {
    all: PERMISSIONS.PAYROLL_VIEW_ALL,
    team: PERMISSIONS.PAYROLL_VIEW_TEAM,
    self: PERMISSIONS.PAYROLL_VIEW_SELF,
  })
  await assertEmployeeInScope(auth, employeeId, scope)

  const rows = await repository.listItemsForEmployee(employeeId, auth.organizationId, { year, limit })
  return rows.map(presentItem)
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

export async function createAdjustment(auth: AuthContext, input: AdjustmentCreateInput, context: AuditContext) {
  await assertEmployeeInScope(auth, input.employeeId, 'ALL')

  // The target month must not already be closed.
  const targetRun = await repository.findRunByPeriod(auth.organizationId, input.applyYear, input.applyMonth)
  if (targetRun && (targetRun.status === 'APPROVED' || targetRun.status === 'LOCKED')) {
    throw ApiError.payroll(
      `Payroll for ${monthLabel(input.applyYear, input.applyMonth)} is already ${targetRun.status.toLowerCase()}. Apply the adjustment to a later month.`,
    )
  }

  const row = await repository.insertAdjustment({
    organization_id: auth.organizationId,
    employee_id: input.employeeId,
    source_payroll_item_id: input.sourcePayrollItemId ?? null,
    adjustment_type: input.adjustmentType,
    component_code: input.componentCode,
    component_name: input.componentName,
    component_type: input.componentType,
    amount: input.amount,
    apply_year: input.applyYear,
    apply_month: input.applyMonth,
    reason: input.reason,
    created_by: auth.userId,
  })

  await recordAudit({
    ...context,
    action: 'PAYROLL_ADJUSTMENT_CREATED',
    entityType: 'payroll_adjustment',
    entityId: row.id,
    newValues: {
      employeeId: input.employeeId,
      amount: input.amount,
      applyPeriod: `${input.applyYear}-${input.applyMonth}`,
      reason: input.reason,
    },
  })

  await notifyUserForEmployee(input.employeeId, {
    organizationId: auth.organizationId,
    type: 'GENERAL',
    title: 'Payroll adjustment raised',
    body: `An adjustment of ${input.amount} will be applied in ${monthLabel(input.applyYear, input.applyMonth)}.`,
    link: '/my-salary',
  })

  return {
    id: row.id,
    employeeId: row.employee_id,
    adjustmentType: row.adjustment_type,
    componentCode: row.component_code,
    componentName: row.component_name,
    componentType: row.component_type,
    amount: Number(row.amount),
    applyYear: row.apply_year,
    applyMonth: row.apply_month,
    reason: row.reason,
    appliedAt: row.applied_at,
  }
}

function presentAdjustment(row: repository.PayrollAdjustmentRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code ?? null,
    employeeName: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    adjustmentType: row.adjustment_type,
    componentCode: row.component_code,
    componentName: row.component_name,
    componentType: row.component_type,
    amount: Number(row.amount),
    applyYear: row.apply_year,
    applyMonth: row.apply_month,
    reason: row.reason,
    appliedAt: row.applied_at,
  }
}

export async function listAdjustments(
  auth: AuthContext,
  filters: { employeeId?: string; year?: number; month?: number; appliedOnly?: boolean; componentCodePrefix?: string },
) {
  const rows = await repository.listAdjustments(auth.organizationId, filters)
  return rows.map(presentAdjustment)
}

/** An adjustment can only be removed before it has been picked up by a calculated run. */
export async function deleteAdjustment(auth: AuthContext, id: string, context: AuditContext) {
  const existing = await repository.findAdjustment(id, auth.organizationId)
  if (!existing) throw ApiError.notFound('Payroll adjustment')
  if (existing.applied_at) {
    throw ApiError.businessRule(
      'This adjustment has already been applied to a calculated payroll run and cannot be deleted. Raise a reversing adjustment instead.',
    )
  }

  const targetRun = await repository.findRunByPeriod(auth.organizationId, existing.apply_year, existing.apply_month)
  if (targetRun && (targetRun.status === 'APPROVED' || targetRun.status === 'LOCKED')) {
    throw ApiError.payroll(
      `Payroll for ${monthLabel(existing.apply_year, existing.apply_month)} is already ${targetRun.status.toLowerCase()} and cannot be changed.`,
    )
  }

  await repository.deleteAdjustment(id, auth.organizationId)
  await recordAudit({
    ...context,
    action: 'PAYROLL_ADJUSTMENT_DELETED',
    entityType: 'payroll_adjustment',
    entityId: id,
    oldValues: presentAdjustment(existing),
  })
}

export type { TxClient }
