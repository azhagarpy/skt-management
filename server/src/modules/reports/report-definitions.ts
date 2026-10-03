import type { PermissionCode } from '../auth/permissions.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { ApiError } from '../../utils/api-error.js'
import { countDaysBetween, datesBetween, type IsoDate } from '../../utils/dates.js'

/**
 * The report catalogue (plan section 41).
 *
 * Every report is a declarative definition rather than a bespoke endpoint: a SQL
 * body, the filters it accepts, the columns it renders, and the permission it
 * needs. One generic runner then serves all of them as JSON, CSV, Excel or PDF,
 * so adding a report means adding an entry here.
 *
 * `sql` is a fragment; the runner appends scope, filters, ordering and paging.
 * Filters are always bound as parameters - no report interpolates user input.
 */

export type ReportCategory = 'EMPLOYEE' | 'ATTENDANCE' | 'LEAVE' | 'PAYROLL' | 'PAYMENT' | 'STATUTORY'

/** `amount`: a plain figure to two decimals, for a column whose rows hold different kinds of figure. */
export type ColumnFormat = 'text' | 'number' | 'currency' | 'amount' | 'date' | 'days' | 'percent'

export interface ReportColumn {
  key: string
  label: string
  format: ColumnFormat
  /** Column totals are shown for currency and day columns when true. */
  total?: boolean
  /**
   * Left out when no row has a value for it - a month with no payroll, say.
   * Honoured for reports filled in by an enricher, whose rows are all loaded.
   */
  dropWhenEmpty?: boolean
}

export type FilterKey =
  | 'from'
  | 'to'
  | 'year'
  | 'month'
  /** A range of payroll months, each "YYYY-MM": every month from one to the other. */
  | 'fromMonth'
  | 'toMonth'
  | 'departmentId'
  | 'supervisorId'
  | 'employeeId'
  | 'locationId'
  | 'employmentStatus'
  | 'attendanceStatus'
  | 'leaveStatus'
  | 'paymentStatus'
  | 'payrollRunId'

/** The period a report runs over, as its filters give it. */
export interface ReportPeriod {
  from?: IsoDate
  to?: IsoDate
  /** "YYYY-MM" */
  fromMonth?: string
  toMonth?: string
}

export interface ReportDefinition {
  key: string
  name: string
  description: string
  category: ReportCategory
  permission: PermissionCode
  /**
   * A permission needed on top of viewing reports, for a report that carries
   * sensitive data. Without it the report is neither listed nor run.
   */
  requires?: PermissionCode
  columns: ReportColumn[]
  /**
   * For a report whose columns depend on the period it covers - one per day,
   * say: the full column list for the period, in place of `columns`, which is
   * then what the catalogue shows before a period is chosen.
   */
  columnsFor?: (period: ReportPeriod) => ReportColumn[]
  filters: FilterKey[]
  /** Filters without which the report is meaningless. */
  requiredFilters?: FilterKey[]
  /**
   * Alternative filter sets, at least one of which must be given in full - e.g.
   * a month (year and month) or a date range (from and to).
   */
  requiredOneOf?: FilterKey[][]
  /**
   * The SELECT ... FROM ... body. `{{scope}}` is replaced with the employee
   * scope predicate and `{{filters}}` with the bound filter predicates.
   */
  sql: string
  /**
   * Each row belongs to one payroll month, which the SQL selects as
   * `report_month`; run over a month range, the report gains a Month column.
   */
  monthColumn?: boolean
  orderBy: string
  /** Alias of the employees table, used to apply the caller's scope. */
  employeeAlias: string
}

const EMPLOYEE_COLUMNS: ReportColumn[] = [
  { key: 'employee_code', label: 'Employee ID', format: 'text' },
  { key: 'employee_name', label: 'Name', format: 'text' },
  { key: 'department_name', label: 'Department', format: 'text' },
  { key: 'designation_name', label: 'Section', format: 'text' },
]

/**
 * A payroll item's (`i`) pay split into its categories, joined as `pc`, so the
 * columns of a salary report add up for every row and for the totals:
 *
 *   gross - total deductions + overtime + other credits = net
 *
 * Overtime is added to net pay outside gross. On an item calculated before
 * that, it was an earning inside gross, so it is taken back out of gross here
 * and shown with the rest of the overtime: every month reports the overtime it
 * paid, and adds up the same way.
 */
const PAY_CATEGORIES_JOIN = `
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(pcc.amount) FILTER (WHERE pcc.component_code = 'PF_EMPLOYEE'), 0)  AS pf_employee,
           coalesce(sum(pcc.amount) FILTER (WHERE pcc.component_code = 'ESI_EMPLOYEE'), 0) AS esi_employee,
           coalesce(sum(pcc.amount) FILTER (WHERE pcc.component_code = 'PTAX'), 0)         AS ptax,
           coalesce(sum(pcc.amount) FILTER (WHERE pcc.component_code = 'LWF_EMPLOYEE'), 0) AS lwf,
           coalesce(sum(pcc.amount) FILTER (WHERE pcc.source = 'OVERTIME'), 0)            AS overtime,
           coalesce(sum(pcc.amount) FILTER (WHERE pcc.source = 'OVERTIME' AND pcc.component_type = 'EARNING'), 0)
             AS overtime_in_gross,
           coalesce(sum(pcc.amount) FILTER (WHERE pcc.source = 'HOLIDAY_WORK'), 0)        AS holiday_work
      FROM payroll_item_components pcc
     WHERE pcc.payroll_item_id = i.id
  ) pc ON true`

/** Each category as a select expression over `i` and `pc`. */
const PAY_CATEGORY_SQL = {
  gross: '(i.gross_earnings - pc.overtime_in_gross)',
  pfEmployee: 'pc.pf_employee',
  esiEmployee: 'pc.esi_employee',
  ptax: 'pc.ptax',
  lwf: 'pc.lwf',
  otherDeductions: '(i.total_deductions - pc.pf_employee - pc.esi_employee - pc.ptax - pc.lwf)',
  totalDeductions: 'i.total_deductions',
  overtime: 'pc.overtime',
  otherCredits: 'i.total_credits',
  net: 'i.net_salary',
}

const PAY_CATEGORY_COLUMNS: ReportColumn[] = [
  { key: 'gross_earnings', label: 'Gross Earnings', format: 'currency', total: true },
  { key: 'pf_employee', label: 'PF (Employee)', format: 'currency', total: true },
  { key: 'esi_employee', label: 'ESI (Employee)', format: 'currency', total: true },
  { key: 'ptax', label: 'P.Tax', format: 'currency', total: true },
  { key: 'lwf', label: 'LWF', format: 'currency', total: true },
  { key: 'other_deductions', label: 'Other Deductions', format: 'currency', total: true },
  { key: 'total_deductions', label: 'Total Deductions', format: 'currency', total: true },
  { key: 'overtime_amount', label: 'Overtime', format: 'currency', total: true },
  { key: 'total_credits', label: 'Other Credits', format: 'currency', total: true },
  { key: 'net_salary', label: 'Net Salary', format: 'currency', total: true },
]

/** The per-item select list for PAY_CATEGORY_COLUMNS. */
const PAY_CATEGORY_SELECT = `
             ${PAY_CATEGORY_SQL.gross} AS gross_earnings,
             ${PAY_CATEGORY_SQL.pfEmployee} AS pf_employee,
             ${PAY_CATEGORY_SQL.esiEmployee} AS esi_employee,
             ${PAY_CATEGORY_SQL.ptax} AS ptax,
             ${PAY_CATEGORY_SQL.lwf} AS lwf,
             ${PAY_CATEGORY_SQL.otherDeductions} AS other_deductions,
             ${PAY_CATEGORY_SQL.totalDeductions} AS total_deductions,
             ${PAY_CATEGORY_SQL.overtime} AS overtime_amount,
             ${PAY_CATEGORY_SQL.otherCredits} AS total_credits,
             ${PAY_CATEGORY_SQL.net} AS net_salary`

/** The same, summed over a group of items. */
const PAY_CATEGORY_SUMS = `
             sum(${PAY_CATEGORY_SQL.gross}) AS gross_earnings,
             sum(${PAY_CATEGORY_SQL.pfEmployee}) AS pf_employee,
             sum(${PAY_CATEGORY_SQL.esiEmployee}) AS esi_employee,
             sum(${PAY_CATEGORY_SQL.ptax}) AS ptax,
             sum(${PAY_CATEGORY_SQL.lwf}) AS lwf,
             sum(${PAY_CATEGORY_SQL.otherDeductions}) AS other_deductions,
             sum(${PAY_CATEGORY_SQL.totalDeductions}) AS total_deductions,
             sum(${PAY_CATEGORY_SQL.overtime}) AS overtime_amount,
             sum(${PAY_CATEGORY_SQL.otherCredits}) AS total_credits,
             sum(${PAY_CATEGORY_SQL.net}) AS net_salary`

const PAY_CATEGORIES_NOTE =
  'Gross earnings less total deductions, plus overtime and other credits, is the net salary - on every row and in the totals.'

/** The overtime paid on a payroll item (`i`), for reports without the full breakdown. */
const OVERTIME_AMOUNT = `coalesce((SELECT sum(oc.amount) FROM payroll_item_components oc
                          WHERE oc.payroll_item_id = i.id AND oc.source = 'OVERTIME'), 0)`

/** The longest period the day-by-day attendance report covers: two months. */
export const ATTENDANCE_REPORT_MAX_DAYS = 62

/** The key of the attendance report's column for one day. */
export const attendanceDayKey = (date: IsoDate): string => `day_${date}`

/** A day's column heading, kept short so a month of them fits across a page: "2026-08-21" -> "21/8". */
const dayHeading = (date: IsoDate): string => `${Number(date.slice(8, 10))}/${Number(date.slice(5, 7))}`

/** The attendance reports' totals - whole days of each status - filled in by report-attendance.ts. */
const ATTENDANCE_TOTAL_COLUMNS: ReportColumn[] = [
  { key: 'present_days', label: 'Present', format: 'number', total: true },
  { key: 'absent_days', label: 'Absent', format: 'number', total: true },
  { key: 'leave_days', label: 'Leave', format: 'number', total: true },
  { key: 'half_days', label: 'Half Day', format: 'number', total: true },
  { key: 'holiday_days', label: 'Holiday', format: 'number', total: true },
  { key: 'weekly_off_days', label: 'Weekly Off', format: 'number', total: true },
  { key: 'paid_off_days', label: 'Paid Off', format: 'number', total: true },
  { key: 'unmarked_days', label: 'Not Marked', format: 'number', total: true },
]

/** One column per day of the period, then the totals. */
function attendanceColumns(period: ReportPeriod): ReportColumn[] {
  const { from, to } = period
  if (!from || !to) return [...EMPLOYEE_COLUMNS, ...ATTENDANCE_TOTAL_COLUMNS]
  if (to < from) throw ApiError.badRequest('The end date cannot be before the start date')
  if (countDaysBetween(from, to) > ATTENDANCE_REPORT_MAX_DAYS) {
    throw ApiError.badRequest(
      `Monthly Attendance covers up to ${ATTENDANCE_REPORT_MAX_DAYS} days. Choose a month or a shorter date range.`,
    )
  }
  return [
    ...EMPLOYEE_COLUMNS,
    ...datesBetween(from, to).map(
      (date): ReportColumn => ({ key: attendanceDayKey(date), label: dayHeading(date), format: 'text' }),
    ),
    ...ATTENDANCE_TOTAL_COLUMNS,
  ]
}

const MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Every payroll month from one to another, as "YYYY-MM". */
export function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const months: string[] = []
  let year = Number(fromMonth.slice(0, 4))
  let month = Number(fromMonth.slice(5, 7))
  const last = Number(toMonth.slice(0, 4)) * 100 + Number(toMonth.slice(5, 7))
  while (year * 100 + month <= last) {
    months.push(`${year}-${String(month).padStart(2, '0')}`)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return months
}

/** The Yearly Salary report's column for one payroll month: "2026-03" -> "m2026_03". */
export const yearlyMonthKey = (month: string): string => `m${month.replace('-', '_')}`

/**
 * The Yearly Salary report's rows for each employee, in order: what each one
 * is called and the field of a month's payroll row it comes from
 * (report-yearly-salary.ts). Total wages is every wage earned, overtime
 * included.
 */
export const YEARLY_PARTICULARS: { label: string; source: string }[] = [
  { label: 'Holidays', source: 'eligible_holidays' },
  { label: 'Holiday Wages (without SA)', source: 'holiday_wages' },
  { label: 'Gross Earnings', source: 'gross_earnings' },
  { label: 'Overtime', source: 'overtime_amount' },
  { label: 'Total Wages', source: 'total_wages' },
  { label: 'PF (Employee)', source: 'pf_employee' },
  { label: 'ESI (Employee)', source: 'esi_employee' },
  { label: 'P.Tax', source: 'ptax' },
  { label: 'LWF', source: 'lwf' },
  { label: 'Other Deductions', source: 'other_deductions' },
  { label: 'Total Deductions', source: 'total_deductions' },
  { label: 'Other Credits', source: 'total_credits' },
  { label: 'Net Salary', source: 'net_salary' },
]

/**
 * The months of the range as columns, then their total. A column holds
 * different kinds of figure - a count of holidays above amounts - so it adds
 * no column total; each employee's figure has its own Total, and the report
 * ends with every employee's added up.
 */
function yearlySalaryColumns(period: ReportPeriod): ReportColumn[] {
  const months = period.fromMonth && period.toMonth ? monthsBetween(period.fromMonth, period.toMonth) : []
  return [
    ...EMPLOYEE_COLUMNS,
    { key: 'particulars', label: 'Particulars', format: 'text' },
    ...months.map(
      (month): ReportColumn => ({
        key: yearlyMonthKey(month),
        label: `${MONTH_ABBREVIATIONS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`,
        format: 'amount',
        dropWhenEmpty: true,
      }),
    ),
    { key: 'range_total', label: 'Total', format: 'amount' },
  ]
}

export const REPORT_DEFINITIONS: ReportDefinition[] = [
  // -------------------------------------------------------------------------
  // Employee reports
  // -------------------------------------------------------------------------
  {
    key: 'employee-master',
    name: 'Employee Master',
    description: 'Every employee with their employment details.',
    category: 'EMPLOYEE',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['departmentId', 'supervisorId', 'locationId', 'employmentStatus'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'employee_type_name', label: 'Supply Type', format: 'text' },
      { key: 'supervisor_name', label: 'Supervisor', format: 'text' },
      { key: 'employment_type', label: 'Employment Type', format: 'text' },
      { key: 'employment_status', label: 'Status', format: 'text' },
      { key: 'salary_basis', label: 'Salary Basis', format: 'text' },
      { key: 'joining_date', label: 'Joining Date', format: 'date' },
      { key: 'exit_date', label: 'Exit Date', format: 'date' },
      { key: 'work_email', label: 'Work Email', format: 'text' },
      { key: 'mobile_number', label: 'Mobile', format: 'text' },
    ],
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             t.name AS employee_type_name,
             CASE WHEN s.id IS NULL THEN NULL
                  ELSE trim(s.first_name || ' ' || coalesce(s.last_name, '')) END AS supervisor_name,
             e.employment_type::text AS employment_type,
             e.employment_status::text AS employment_status,
             e.salary_basis::text AS salary_basis,
             e.joining_date,
             e.exit_date,
             e.work_email,
             e.mobile_number
        FROM employees e
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
        LEFT JOIN employees    s ON s.id = e.supervisor_id
        LEFT JOIN employee_types t ON t.id = e.employee_type_id
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'e.employee_code',
  },
  {
    key: 'employee-document-status',
    name: 'Employee Document Status',
    description: 'Which required documents each employee has provided and their verification state.',
    category: 'EMPLOYEE',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['departmentId', 'supervisorId', 'employmentStatus'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'pan_status', label: 'PAN', format: 'text' },
      { key: 'aadhaar_status', label: 'Aadhaar', format: 'text' },
      { key: 'bank_status', label: 'Bank', format: 'text' },
      { key: 'pf_status', label: 'PF', format: 'text' },
      { key: 'esi_status', label: 'ESI', format: 'text' },
      { key: 'completed_sections', label: 'Complete', format: 'number' },
    ],
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             coalesce(pan.verification_status::text, 'MISSING')     AS pan_status,
             coalesce(aad.verification_status::text, 'MISSING')     AS aadhaar_status,
             coalesce(bank.verification_status::text, 'MISSING')    AS bank_status,
             coalesce(pf.verification_status::text, 'MISSING')      AS pf_status,
             coalesce(esi.verification_status::text, 'MISSING')     AS esi_status,
             ((pan.id IS NOT NULL)::int + (aad.id IS NOT NULL)::int + (bank.id IS NOT NULL)::int
              + (pf.id IS NOT NULL)::int + (esi.id IS NOT NULL)::int) AS completed_sections
        FROM employees e
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
        LEFT JOIN employee_pan_details     pan  ON pan.employee_id = e.id
        LEFT JOIN employee_aadhaar_details aad  ON aad.employee_id = e.id
        LEFT JOIN employee_bank_accounts   bank ON bank.employee_id = e.id AND bank.is_primary
        LEFT JOIN employee_pf_details      pf   ON pf.employee_id = e.id
        LEFT JOIN employee_esi_details     esi  ON esi.employee_id = e.id
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'e.employee_code',
  },

  // -------------------------------------------------------------------------
  // Attendance reports
  // -------------------------------------------------------------------------
  {
    key: 'daily-attendance',
    name: 'Daily Attendance',
    description: 'Attendance records for a date range, one row per employee per day.',
    category: 'ATTENDANCE',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['from', 'to', 'departmentId', 'supervisorId', 'employeeId', 'attendanceStatus'],
    requiredFilters: ['from', 'to'],
    columns: [
      { key: 'attendance_date', label: 'Date', format: 'date' },
      ...EMPLOYEE_COLUMNS,
      { key: 'status', label: 'Status', format: 'text' },
      { key: 'leave_type_name', label: 'Leave Type', format: 'text' },
      { key: 'remarks', label: 'Remarks', format: 'text' },
    ],
    sql: `
      SELECT a.attendance_date,
             e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             a.status::text AS status,
             lt.name AS leave_type_name,
             a.remarks
        FROM attendance a
        JOIN employees e ON e.id = a.employee_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
        LEFT JOIN leave_types lt ON lt.id = a.leave_type_id
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'a.attendance_date DESC, e.employee_code',
  },
  {
    key: 'monthly-attendance-summary',
    name: 'Monthly Attendance',
    description:
      "Every employee's attendance on each day of a month or date range, with their totals. A month is the payroll month (the 21st to the 20th). P present, A absent, L leave, HL half-day leave, H holiday, WO weekly off, PO paid off, NM a working day not marked; a day left blank is one the employee was not employed.",
    category: 'ATTENDANCE',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'from', 'to', 'departmentId', 'supervisorId', 'employeeId'],
    requiredOneOf: [
      ['year', 'month'],
      ['from', 'to'],
    ],
    // The day columns and the totals are filled in by report-attendance.ts.
    columns: attendanceColumns({}),
    columnsFor: attendanceColumns,
    // Everyone employed at any point in the period, marked or not, as the
    // attendance calendar lists them; the period filters match on employment.
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             -- Not shown as columns: what each day's status is worked out from.
             e.id AS employee_id,
             e.department_id,
             e.location_id,
             e.joining_date,
             e.exit_date
        FROM employees e
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}} AND e.employment_status <> 'INACTIVE'
    `,
    orderBy: 'e.employee_code',
  },
  {
    key: 'holiday-report',
    name: 'Holiday Report',
    description:
      'The holidays in a month or date range and everyone paid for them. Those who worked a holiday - a full day or a half day - get the day\'s wage and the extra pay for working it. Those who rested on it get the holiday pay as Extra Pay, without the components left out of holiday pay (Special Allowance), unless they lost it by being absent or on a half day on both sides of it.',
    category: 'ATTENDANCE',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'from', 'to', 'departmentId', 'employeeId'],
    requiredOneOf: [
      ['year', 'month'],
      ['fromMonth', 'toMonth'],
      ['from', 'to'],
    ],
    // The amounts are filled in by report-amounts.ts, with payroll's arithmetic.
    columns: [
      { key: 'holiday_date', label: 'Date', format: 'date' },
      { key: 'holiday_name', label: 'Holiday', format: 'text' },
      ...EMPLOYEE_COLUMNS,
      { key: 'worked', label: 'Worked', format: 'text' },
      { key: 'days_worked', label: 'Days Worked', format: 'days', total: true },
      { key: 'holiday_wage', label: 'Holiday Wage', format: 'currency', total: true },
      { key: 'extra_pay', label: 'Extra Pay', format: 'currency', total: true },
      { key: 'total_amount', label: 'Total Amount', format: 'currency', total: true },
    ],
    // Only mandatory holidays count: an optional one leaves the day a working
    // day (calendar.service.ts). Holidays are matched by date, not by
    // attendance.holiday_id, because a day imported as worked carries no
    // holiday link. Two calendars listing the same date give one row, with
    // both names. A half day on a holiday is half of it worked, as payroll pays it.
    //
    // A rested holiday - marked as one, or never marked - is a candidate here
    // for everyone employed that day whom payroll pays (not INACTIVE).
    // report-amounts.ts drops the ones payroll would not pay: lost to the
    // sandwich rule, or unmarked on a day their calendar does not keep a holiday.
    sql: `
      SELECT h.holiday_date,
             h.name AS holiday_name,
             e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             CASE a.status WHEN 'PRESENT' THEN 'Full day' WHEN 'HALF_DAY_LEAVE' THEN 'Half day' ELSE 'Rested' END AS worked,
             CASE a.status WHEN 'PRESENT' THEN 1 WHEN 'HALF_DAY_LEAVE' THEN 0.5 ELSE 0 END AS days_worked,
             -- Not shown as columns: what the amounts are worked out from.
             a.status AS attendance_status,
             e.id AS employee_id,
             e.department_id,
             e.location_id,
             e.joining_date,
             e.exit_date
        FROM (SELECT organization_id, holiday_date, string_agg(DISTINCT name, ' / ' ORDER BY name) AS name
                FROM holidays
               WHERE NOT is_optional
               GROUP BY organization_id, holiday_date) h
        JOIN employees e ON e.organization_id = h.organization_id
        LEFT JOIN attendance a ON a.employee_id = e.id AND a.attendance_date = h.holiday_date
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}}
         AND (a.status IN ('PRESENT', 'HALF_DAY_LEAVE')
              OR ((a.status IS NULL OR a.status = 'HOLIDAY')
                  AND e.joining_date <= h.holiday_date
                  AND (e.exit_date IS NULL OR e.exit_date >= h.holiday_date)
                  AND e.employment_status <> 'INACTIVE'))
    `,
    orderBy: 'h.holiday_date, e.employee_code',
  },
  {
    key: 'overtime-report',
    name: 'Overtime Report',
    description:
      'Overtime hours by employee and date, with the rate and amount each is paid. A month is the payroll month (the 21st to the 20th), so the amounts match that month\'s payslips.',
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'from', 'to', 'departmentId', 'employeeId'],
    requiredOneOf: [
      ['year', 'month'],
      ['fromMonth', 'toMonth'],
      ['from', 'to'],
    ],
    // The rate and amount are filled in by report-amounts.ts, with payroll's arithmetic.
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'work_date', label: 'Date', format: 'date' },
      { key: 'hours', label: 'OT Hours', format: 'number', total: true },
      { key: 'rate', label: 'Rate', format: 'text' },
      { key: 'rate_per_hour', label: 'Rate / Hour', format: 'currency' },
      { key: 'amount', label: 'Amount', format: 'currency', total: true },
    ],
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             o.work_date,
             o.hours,
             -- Not shown as columns: what the rate and amount are worked out from.
             e.id AS employee_id,
             e.joining_date,
             e.exit_date,
             t.overtime_handling::text AS overtime_handling,
             o.rate_basis,
             o.day_divisor,
             o.rate_per_hour_minor
        FROM overtime_entries o
        JOIN employees e ON e.id = o.employee_id
        JOIN employee_types t ON t.id = e.employee_type_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'e.employee_code, o.work_date',
  },

  // -------------------------------------------------------------------------
  // Leave reports
  // -------------------------------------------------------------------------
  {
    key: 'leave-requests',
    name: 'Leave Requests',
    description: 'Leave requests with their status and decision.',
    category: 'LEAVE',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['from', 'to', 'departmentId', 'supervisorId', 'employeeId', 'leaveStatus'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'leave_type_name', label: 'Leave Type', format: 'text' },
      { key: 'from_date', label: 'From', format: 'date' },
      { key: 'to_date', label: 'To', format: 'date' },
      { key: 'total_days', label: 'Days', format: 'days', total: true },
      { key: 'status', label: 'Status', format: 'text' },
      { key: 'decided_by_name', label: 'Decided By', format: 'text' },
      { key: 'reason', label: 'Reason', format: 'text' },
    ],
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             lt.name AS leave_type_name,
             r.from_date,
             r.to_date,
             r.total_days,
             r.status::text AS status,
             u.full_name AS decided_by_name,
             r.reason
        FROM leave_requests r
        JOIN employees e ON e.id = r.employee_id
        JOIN leave_types lt ON lt.id = r.leave_type_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
        LEFT JOIN users u ON u.id = r.decided_by
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'r.from_date DESC, e.employee_code',
  },
  {
    key: 'leave-balances',
    name: 'Leave Balance',
    description: 'Entitlement, used and available leave per employee and leave type.',
    category: 'LEAVE',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'departmentId', 'supervisorId', 'employeeId'],
    requiredFilters: ['year'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'leave_type_name', label: 'Leave Type', format: 'text' },
      { key: 'entitled', label: 'Entitled', format: 'days', total: true },
      { key: 'used', label: 'Used', format: 'days', total: true },
      { key: 'pending', label: 'Pending', format: 'days', total: true },
      { key: 'available', label: 'Available', format: 'days', total: true },
    ],
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             lt.name AS leave_type_name,
             (b.opening_balance + b.accrued + b.carried_forward + b.adjustment) AS entitled,
             b.used,
             b.pending,
             (b.opening_balance + b.accrued + b.carried_forward + b.adjustment - b.used - b.pending) AS available
        FROM employee_leave_balances b
        JOIN employees e ON e.id = b.employee_id
        JOIN leave_types lt ON lt.id = b.leave_type_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'e.employee_code, lt.name',
  },

  // -------------------------------------------------------------------------
  // Payroll reports
  // -------------------------------------------------------------------------
  {
    key: 'salary-register',
    name: 'Salary Register',
    description: `The full payroll register for a month, split by category. ${PAY_CATEGORIES_NOTE} Working Days are the days worked, holidays worked included. Eligible Holidays are the holidays that earn holiday pay: those rested on and not lost to leave on both sides, and those worked. Holiday Wages is their holiday pay, without the components left out of holiday pay (Special Allowance) - for a holiday worked, on top of the day's work counted in Working Days - and is part of gross earnings.`,
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'departmentId', 'supervisorId', 'payrollRunId', 'paymentStatus'],
    requiredOneOf: [
      ['year', 'month'],
      ['fromMonth', 'toMonth'],
    ],
    // The working days and holiday figures are filled in by report-amounts.ts.
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'paid_days', label: 'Paid Days', format: 'days', total: true },
      { key: 'working_days', label: 'Working Days', format: 'days', total: true },
      { key: 'eligible_holidays', label: 'Eligible Holidays', format: 'days', total: true },
      { key: 'holiday_wages', label: 'Holiday Wages', format: 'currency', total: true },
      ...PAY_CATEGORY_COLUMNS,
      { key: 'paid_amount', label: 'Paid', format: 'currency', total: true },
      { key: 'pending_amount', label: 'Pending', format: 'currency', total: true },
      { key: 'payment_status', label: 'Payment Status', format: 'text' },
    ],
    sql: `
      SELECT to_char(make_date(r.year, r.month, 1), 'Mon YYYY') AS report_month,
             i.employee_code,
             i.employee_name,
             i.department_name,
             i.designation_name,
             i.paid_days,${PAY_CATEGORY_SELECT},
             i.paid_amount,
             i.pending_amount,
             i.payment_status::text AS payment_status,
             -- Not shown as columns: what the working days and holiday figures are
             -- worked out from - what payroll itself used for the item.
             pc.holiday_work AS holiday_extra_pay,
             i.present_days,
             i.half_day_leave_days,
             i.holiday_days,
             i.salary_structure_id,
             i.payable_days_basis,
             i.calculation_snapshot->'days' AS snapshot_days,
             asg.override_amount
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id
        LEFT JOIN employee_salary_assignments asg ON asg.id = i.salary_assignment_id${PAY_CATEGORIES_JOIN}
       WHERE {{scope}} {{filters}}
    `,
    monthColumn: true,
    orderBy: 'r.year, r.month, i.employee_code',
  },
  {
    key: 'payment-status',
    name: 'Payment Status Report',
    description: `What has been paid and what is still outstanding for a month, with the net salary split by category. ${PAY_CATEGORIES_NOTE}`,
    category: 'PAYMENT',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'departmentId', 'paymentStatus', 'payrollRunId'],
    requiredOneOf: [
      ['year', 'month'],
      ['fromMonth', 'toMonth'],
    ],
    columns: [
      ...EMPLOYEE_COLUMNS,
      ...PAY_CATEGORY_COLUMNS,
      { key: 'paid_amount', label: 'Paid', format: 'currency', total: true },
      { key: 'pending_amount', label: 'Pending', format: 'currency', total: true },
      { key: 'payment_status', label: 'Status', format: 'text' },
      { key: 'last_payment_date', label: 'Last Payment', format: 'date' },
    ],
    sql: `
      SELECT to_char(make_date(r.year, r.month, 1), 'Mon YYYY') AS report_month,
             i.employee_code,
             i.employee_name,
             i.department_name,
             i.designation_name,${PAY_CATEGORY_SELECT},
             i.paid_amount,
             i.pending_amount,
             i.payment_status::text AS payment_status,
             (SELECT max(t.payment_date) FROM payroll_payment_transactions t
               WHERE t.payroll_item_id = i.id AND t.reversed_at IS NULL) AS last_payment_date
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id${PAY_CATEGORIES_JOIN}
       WHERE {{scope}} {{filters}}
    `,
    monthColumn: true,
    orderBy: 'r.year, r.month, i.payment_status, i.employee_code',
  },
  {
    key: 'payment-transactions',
    name: 'Payment Transactions',
    description: 'Every salary payment recorded in a date range, including partial payments.',
    category: 'PAYMENT',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['from', 'to', 'departmentId', 'employeeId'],
    requiredFilters: ['from', 'to'],
    columns: [
      { key: 'payment_date', label: 'Date', format: 'date' },
      ...EMPLOYEE_COLUMNS,
      { key: 'amount', label: 'Amount', format: 'currency', total: true },
      { key: 'payment_method', label: 'Method', format: 'text' },
      { key: 'reference_number', label: 'Reference', format: 'text' },
      { key: 'is_reversed', label: 'Reversed', format: 'text' },
    ],
    sql: `
      SELECT t.payment_date,
             i.employee_code,
             i.employee_name,
             i.department_name,
             i.designation_name,
             t.amount,
             t.payment_method::text AS payment_method,
             t.reference_number,
             CASE WHEN t.reversed_at IS NULL THEN 'No' ELSE 'Yes' END AS is_reversed
        FROM payroll_payment_transactions t
        JOIN payroll_items i ON i.id = t.payroll_item_id
        JOIN employees e ON e.id = i.employee_id
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 't.payment_date DESC, i.employee_code',
  },
  {
    key: 'bank-transfer',
    name: 'Bank Transfer Statement',
    description:
      "The salary list to send to the bank for a payroll month: each employee's primary bank account and the net salary to pay them. Anyone with no bank account on file is still listed, with the account details blank, so nobody is left out unnoticed. Employees with no net pay are not listed.",
    category: 'PAYMENT',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    // It carries full account numbers.
    requires: PERMISSIONS.SENSITIVE_DATA_VIEW,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'departmentId', 'paymentStatus', 'payrollRunId'],
    requiredOneOf: [
      ['year', 'month'],
      ['fromMonth', 'toMonth'],
    ],
    columns: [
      { key: 'employee_code', label: 'Employee ID', format: 'text' },
      { key: 'employee_name', label: 'Name', format: 'text' },
      { key: 'account_number', label: 'Account Number', format: 'text' },
      { key: 'ifsc_code', label: 'IFSC Code', format: 'text' },
      { key: 'branch_name', label: 'Branch', format: 'text' },
      { key: 'net_salary', label: 'Amount', format: 'currency', total: true },
    ],
    sql: `
      SELECT to_char(make_date(r.year, r.month, 1), 'Mon YYYY') AS report_month,
             i.employee_code,
             i.employee_name,
             b.account_number,
             b.ifsc_code,
             b.branch_name,
             i.net_salary
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id
        LEFT JOIN employee_bank_accounts b ON b.employee_id = i.employee_id AND b.is_primary
       WHERE {{scope}} {{filters}} AND i.net_salary > 0
    `,
    monthColumn: true,
    orderBy: 'r.year, r.month, i.employee_code',
  },
  {
    key: 'bonus-report',
    name: 'Bonus Report',
    description: 'Bonuses by employee and month, and how and when each was paid. Bonuses are paid separately from salary.',
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'departmentId', 'employeeId'],
    requiredOneOf: [['year'], ['fromMonth', 'toMonth']],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'bonus_name', label: 'Bonus Name', format: 'text' },
      { key: 'amount', label: 'Amount', format: 'currency', total: true },
      { key: 'bonus_date', label: 'Bonus Date', format: 'date' },
      { key: 'status', label: 'Status', format: 'text' },
      { key: 'paid_on', label: 'Paid On', format: 'date' },
      { key: 'payment_method', label: 'Paid By', format: 'text' },
      { key: 'reference_number', label: 'Reference', format: 'text' },
    ],
    sql: `
      SELECT to_char(make_date(b.payroll_year, b.payroll_month, 1), 'Mon YYYY') AS report_month,
             e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             b.bonus_name,
             b.amount,
             b.bonus_date,
             b.status::text AS status,
             b.paid_on,
             b.payment_method::text AS payment_method,
             b.reference_number
        FROM employee_bonuses b
        JOIN employees e ON e.id = b.employee_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}}
    `,
    monthColumn: true,
    orderBy: 'b.payroll_year DESC, b.payroll_month DESC, e.employee_code',
  },
  {
    key: 'tax-deductions-report',
    name: 'Panchayat Tax Report',
    description: 'Panchayat tax deducted from salary, by employee and payroll month.',
    category: 'STATUTORY',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'departmentId', 'employeeId'],
    requiredOneOf: [['year'], ['fromMonth', 'toMonth']],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'wage_base', label: 'Wages Charged On', format: 'currency', total: true },
      { key: 'tax_amount', label: 'Tax Amount', format: 'currency', total: true },
      { key: 'period_from', label: 'Wage Period From', format: 'date' },
      { key: 'period_to', label: 'Wage Period To', format: 'date' },
    ],
    sql: `
      SELECT to_char(make_date(t.payroll_year, t.payroll_month, 1), 'Mon YYYY') AS report_month,
             e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             t.wage_base,
             t.tax_amount,
             t.period_from,
             t.period_to
        FROM tax_deductions t
        JOIN employees e ON e.id = t.employee_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}}
    `,
    monthColumn: true,
    orderBy: 't.payroll_year DESC, t.payroll_month DESC, e.employee_code',
  },
  {
    key: 'other-deductions-report',
    name: 'Other Deductions Report',
    description: 'One-off deductions - penalties, recoveries and the like - by employee and payroll month.',
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'departmentId', 'employeeId'],
    requiredOneOf: [['year'], ['fromMonth', 'toMonth']],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'category', label: 'Category', format: 'text' },
      { key: 'amount', label: 'Amount', format: 'currency', total: true },
      { key: 'reason', label: 'Reason', format: 'text' },
      { key: 'status', label: 'Status', format: 'text' },
    ],
    sql: `
      SELECT to_char(make_date(a.apply_year, a.apply_month, 1), 'Mon YYYY') AS report_month,
             e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             a.component_name AS category,
             a.amount,
             a.reason,
             CASE WHEN a.applied_at IS NOT NULL THEN 'Applied' ELSE 'Pending' END AS status
        FROM payroll_adjustments a
        JOIN employees e ON e.id = a.employee_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}} AND a.component_code LIKE 'OD\\_%'
    `,
    monthColumn: true,
    orderBy: 'a.apply_year DESC, a.apply_month DESC, e.employee_code',
  },
  {
    key: 'other-credits-report',
    name: 'Other Credits Report',
    description: 'One-off amounts added straight to net pay - incentives, reimbursements and the like - by employee and payroll month.',
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'departmentId', 'employeeId'],
    requiredOneOf: [['year'], ['fromMonth', 'toMonth']],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'category', label: 'Category', format: 'text' },
      { key: 'amount', label: 'Amount', format: 'currency', total: true },
      { key: 'reason', label: 'Reason', format: 'text' },
      { key: 'status', label: 'Status', format: 'text' },
    ],
    sql: `
      SELECT to_char(make_date(a.apply_year, a.apply_month, 1), 'Mon YYYY') AS report_month,
             e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             a.component_name AS category,
             a.amount,
             a.reason,
             CASE WHEN a.applied_at IS NOT NULL THEN 'Applied' ELSE 'Pending' END AS status
        FROM payroll_adjustments a
        JOIN employees e ON e.id = a.employee_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}} AND a.component_code LIKE 'OC\\_%'
    `,
    monthColumn: true,
    orderBy: 'a.apply_year DESC, a.apply_month DESC, e.employee_code',
  },
  {
    key: 'lwf-report',
    name: 'Labour Welfare Fund Report',
    description: 'Labour Welfare Fund contributions by employee and contribution year.',
    category: 'STATUTORY',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'departmentId', 'employeeId'],
    requiredFilters: ['year'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'employee_amount', label: 'Employee Share', format: 'currency', total: true },
      { key: 'employer_amount', label: 'Employer Share', format: 'currency', total: true },
      { key: 'total_amount', label: 'Total', format: 'currency', total: true },
      { key: 'status', label: 'Status', format: 'text' },
      { key: 'paid_on', label: 'Paid On', format: 'date' },
      { key: 'reference_number', label: 'Reference Number', format: 'text' },
    ],
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             l.employee_amount,
             l.employer_amount,
             (l.employee_amount + l.employer_amount) AS total_amount,
             l.status::text AS status,
             l.paid_on,
             l.reference_number
        FROM lwf_contributions l
        JOIN employees e ON e.id = l.employee_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'l.contribution_year DESC, e.employee_code',
  },
  {
    key: 'pl-wages-report',
    name: 'PL Wages Report',
    description: 'PL Wages eligibility and credit amount by employee and credit year, and how and when each was paid. PL Wages are paid separately from salary.',
    category: 'STATUTORY',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'departmentId', 'employeeId'],
    requiredFilters: ['year'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'qualifying_months', label: 'Qualifying Months', format: 'number' },
      { key: 'total_days_worked', label: 'Total Days Worked', format: 'days', total: true },
      { key: 'eligible_days', label: 'Eligible Days', format: 'number', total: true },
      { key: 'daily_wage_rate', label: 'Daily Wage Rate', format: 'currency' },
      { key: 'credit_amount', label: 'Credit Amount', format: 'currency', total: true },
      { key: 'status', label: 'Status', format: 'text' },
      { key: 'paid_on', label: 'Paid On', format: 'date' },
      { key: 'payment_method', label: 'Paid By', format: 'text' },
      { key: 'reference_number', label: 'Reference', format: 'text' },
    ],
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             c.qualifying_months,
             c.total_days_worked,
             c.eligible_days,
             c.daily_wage_rate,
             c.credit_amount,
             c.status::text AS status,
             c.paid_on,
             c.payment_method::text AS payment_method,
             c.reference_number
        FROM pl_wages_credits c
        JOIN employees e ON e.id = c.employee_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'c.credit_year DESC, e.employee_code',
  },
  {
    key: 'pf-report',
    name: 'PF Report',
    description: 'Employee and employer provident fund contributions for a month.',
    category: 'STATUTORY',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'departmentId', 'payrollRunId'],
    requiredOneOf: [
      ['year', 'month'],
      ['fromMonth', 'toMonth'],
    ],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'pf_number', label: 'PF Number', format: 'text' },
      { key: 'pf_name', label: 'Name (as per PF)', format: 'text' },
      { key: 'total_wages', label: 'Total Wages', format: 'currency', total: true },
      { key: 'overtime_amount', label: 'Overtime', format: 'currency', total: true },
      { key: 'pf_wage_ceiling', label: 'PF Wage Ceiling', format: 'currency' },
      { key: 'pf_covered_amount', label: 'PF Covered Amount', format: 'currency', total: true },
      { key: 'employee_contribution', label: 'Employee Contribution', format: 'currency', total: true },
      { key: 'employer_eps', label: 'Employer Contribution (EPS)', format: 'currency', total: true },
      { key: 'employer_epf', label: 'Employer Contribution (EPF)', format: 'currency', total: true },
      { key: 'leaves_taken', label: 'Leaves Taken', format: 'days', total: true },
      { key: 'pension_applicable', label: 'Pension (1/0)', format: 'number' },
    ],
    sql: `
      SELECT to_char(make_date(r.year, r.month, 1), 'Mon YYYY') AS report_month,
             i.employee_code,
             i.employee_name,
             i.department_name,
             i.designation_name,
             coalesce(pf.pf_member_id, pf.uan_number) AS pf_number,
             coalesce(pf.pf_name, i.employee_name) AS pf_name,
             -- Every wage earned in the month, overtime included.
             (i.gross_earnings + i.total_overtime) AS total_wages,
             ${OVERTIME_AMOUNT} AS overtime_amount,
             i.pf_wage_ceiling,
             i.pf_wage AS pf_covered_amount,
             coalesce((SELECT c.amount FROM payroll_item_components c
                        WHERE c.payroll_item_id = i.id AND c.component_code = 'PF_EMPLOYEE'), 0) AS employee_contribution,
             coalesce((SELECT c.amount FROM payroll_item_components c
                        WHERE c.payroll_item_id = i.id AND c.component_code = 'PF_EMPLOYER_EPS'), 0) AS employer_eps,
             coalesce((SELECT c.amount FROM payroll_item_components c
                        WHERE c.payroll_item_id = i.id AND c.component_code = 'PF_EMPLOYER_EPF'), 0) AS employer_epf,
             i.leave_days AS leaves_taken,
             coalesce(pf.pension_applicable, false)::int AS pension_applicable,
             -- Not shown as columns: used by the PF text (ECR) export only.
             coalesce(pf.uan_number, pf.pf_member_id) AS ecr_member_number,
             coalesce(pf.pf_applicable, false) AS ecr_pf_applicable,
             -- Days not worked: everything except a worked day, so weekly offs,
             -- holidays, leave and absences all count. A half-day leave is half
             -- a day not worked.
             greatest(round(i.calendar_days - i.present_days - i.half_day_leave_days * 0.5), 0)::int AS ecr_ncp_days
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id
        LEFT JOIN employee_pf_details pf ON pf.employee_id = i.employee_id
       WHERE {{scope}} {{filters}}
    `,
    monthColumn: true,
    orderBy: 'r.year, r.month, i.employee_code',
  },
  {
    key: 'esi-report',
    name: 'ESI Report',
    description: 'The ESIC monthly contribution upload format: one row per insured person covered under ESI.',
    category: 'STATUTORY',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'departmentId', 'payrollRunId'],
    requiredOneOf: [
      ['year', 'month'],
      ['fromMonth', 'toMonth'],
    ],
    columns: [
      { key: 'ip_number', label: 'IP Number', format: 'text' },
      { key: 'ip_name', label: 'IP Name', format: 'text' },
      { key: 'days_paid', label: 'No of Days for which wages paid/payable during the month', format: 'number' },
      { key: 'total_wages', label: 'Total Monthly Wages', format: 'currency', total: true },
      { key: 'reason_code', label: 'Reason Code for Zero working days', format: 'number' },
      { key: 'last_working_day', label: 'Last Working Day', format: 'text' },
    ],
    // Reason code and last working day are a best-effort default from
    // employment status alone (0 = normal/no reason, 2 = left service): the
    // other ESIC codes (retired, out of coverage, strike, etc.) need a human
    // judgement call this data model cannot make, so verify before uploading.
    sql: `
      SELECT to_char(make_date(r.year, r.month, 1), 'Mon YYYY') AS report_month,
             esi.esi_number AS ip_number,
             coalesce(esi.esi_name, i.employee_name) AS ip_name,
             ceil(i.paid_days)::int AS days_paid,
             -- Every wage earned in the month, overtime included. The columns are
             -- the ESIC upload template, so overtime has no column of its own.
             (i.gross_earnings + i.total_overtime) AS total_wages,
             CASE
               WHEN i.gross_earnings > 0 THEN 0
               WHEN e.employment_status IN ('INACTIVE', 'RESIGNED', 'TERMINATED') AND e.exit_date IS NOT NULL THEN 2
               ELSE 0
             END AS reason_code,
             CASE
               WHEN i.gross_earnings = 0 AND e.employment_status IN ('INACTIVE', 'RESIGNED', 'TERMINATED')
                    AND e.exit_date IS NOT NULL
               THEN to_char(e.exit_date, 'DD/MM/YYYY')
               ELSE NULL
             END AS last_working_day
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id
        JOIN employee_esi_details esi ON esi.employee_id = i.employee_id AND esi.esi_applicable
       WHERE {{scope}} {{filters}}
    `,
    monthColumn: true,
    orderBy: 'r.year, r.month, esi.esi_number',
  },
  {
    key: 'department-salary',
    name: 'Department Salary Report',
    description: `Payroll totals grouped by department, for a month or a range of months, split by category. ${PAY_CATEGORIES_NOTE}`,
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'fromMonth', 'toMonth', 'payrollRunId'],
    requiredOneOf: [
      ['year', 'month'],
      ['fromMonth', 'toMonth'],
    ],
    columns: [
      { key: 'department_name', label: 'Department', format: 'text' },
      { key: 'employees', label: 'Employees', format: 'number', total: true },
      ...PAY_CATEGORY_COLUMNS,
      { key: 'paid_amount', label: 'Paid', format: 'currency', total: true },
      { key: 'pending_amount', label: 'Pending', format: 'currency', total: true },
    ],
    sql: `
      SELECT coalesce(i.department_name, 'Unassigned') AS department_name,
             count(DISTINCT i.employee_id) AS employees,${PAY_CATEGORY_SUMS},
             sum(i.paid_amount)      AS paid_amount,
             sum(i.pending_amount)   AS pending_amount
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id${PAY_CATEGORIES_JOIN}
       WHERE {{scope}} {{filters}}
       GROUP BY coalesce(i.department_name, 'Unassigned')
    `,
    orderBy: 'department_name',
  },
  {
    key: 'payroll-summary',
    name: 'Payroll Summary',
    description: `Each employee's payroll totalled over a range of payroll months - a year, say - split by category. ${PAY_CATEGORIES_NOTE}`,
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['fromMonth', 'toMonth', 'departmentId', 'supervisorId', 'employeeId'],
    requiredFilters: ['fromMonth', 'toMonth'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'months', label: 'Months Paid', format: 'number', total: true },
      { key: 'paid_days', label: 'Paid Days', format: 'days', total: true },
      ...PAY_CATEGORY_COLUMNS,
      { key: 'paid_amount', label: 'Paid', format: 'currency', total: true },
      { key: 'pending_amount', label: 'Pending', format: 'currency', total: true },
    ],
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             count(*) AS months,
             sum(i.paid_days) AS paid_days,${PAY_CATEGORY_SUMS},
             sum(i.paid_amount) AS paid_amount,
             sum(i.pending_amount) AS pending_amount
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id${PAY_CATEGORIES_JOIN}
       WHERE {{scope}} {{filters}}
       GROUP BY e.id, e.employee_code, e.first_name, e.last_name, d.name, g.name
    `,
    orderBy: 'e.employee_code',
  },
  {
    key: 'yearly-salary',
    name: 'Yearly Salary Report',
    description: `Each employee's salary for every month of a range of payroll months - a year, say - with the months as columns and a Total. Each employee has a row for each figure: the holidays that earned holiday pay, their Holiday Wages without the components left out of holiday pay (Special Allowance), gross earnings, overtime, total wages (gross earnings plus overtime), PF, ESI, P.Tax, LWF, other deductions, total deductions, other credits and net salary. ${PAY_CATEGORIES_NOTE} The last rows add up every employee. Months with no payroll are left out.`,
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['fromMonth', 'toMonth', 'departmentId', 'supervisorId', 'employeeId'],
    requiredFilters: ['fromMonth', 'toMonth'],
    // One row per employee and month here; report-yearly-salary.ts works out
    // each month's holiday figures as the Salary Register does, then turns
    // them into a row per figure with the months as columns.
    columns: yearlySalaryColumns({}),
    columnsFor: yearlySalaryColumns,
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             -- Not shown as columns: the month, and what its figures are worked out from.
             e.id AS employee_id,
             r.year AS run_year,
             r.month AS run_month,${PAY_CATEGORY_SELECT},
             pc.holiday_work AS holiday_extra_pay,
             i.present_days,
             i.half_day_leave_days,
             i.holiday_days,
             i.salary_structure_id,
             i.payable_days_basis,
             i.calculation_snapshot->'days' AS snapshot_days,
             asg.override_amount
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
        LEFT JOIN employee_salary_assignments asg ON asg.id = i.salary_assignment_id${PAY_CATEGORIES_JOIN}
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'e.employee_code, r.year, r.month',
  },
  {
    key: 'payroll-month-summary',
    name: 'Payroll Month-wise Summary',
    description: `The whole payroll for each month of a range - a year, say - one row per month, split by category. ${PAY_CATEGORIES_NOTE}`,
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['fromMonth', 'toMonth', 'departmentId', 'supervisorId'],
    requiredFilters: ['fromMonth', 'toMonth'],
    columns: [
      { key: 'report_month', label: 'Month', format: 'text' },
      { key: 'employees', label: 'Employees', format: 'number' },
      ...PAY_CATEGORY_COLUMNS,
      { key: 'paid_amount', label: 'Paid', format: 'currency', total: true },
      { key: 'pending_amount', label: 'Pending', format: 'currency', total: true },
    ],
    sql: `
      SELECT to_char(make_date(r.year, r.month, 1), 'Mon YYYY') AS report_month,
             count(*) AS employees,${PAY_CATEGORY_SUMS},
             sum(i.paid_amount) AS paid_amount,
             sum(i.pending_amount) AS pending_amount
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id${PAY_CATEGORIES_JOIN}
       WHERE {{scope}} {{filters}}
       GROUP BY r.year, r.month
    `,
    orderBy: 'r.year, r.month',
  },
  {
    key: 'attendance-summary',
    name: 'Attendance Summary',
    description:
      "Each employee's attendance totalled over a range of payroll months - a year, say - or a date range: the days of each status, counted as the Monthly Attendance report counts them.",
    category: 'ATTENDANCE',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['fromMonth', 'toMonth', 'from', 'to', 'departmentId', 'supervisorId', 'employeeId'],
    requiredOneOf: [
      ['fromMonth', 'toMonth'],
      ['from', 'to'],
    ],
    // The totals are filled in by report-attendance.ts.
    columns: [...EMPLOYEE_COLUMNS, ...ATTENDANCE_TOTAL_COLUMNS],
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             -- Not shown as columns: what each day's status is worked out from.
             e.id AS employee_id,
             e.department_id,
             e.location_id,
             e.joining_date,
             e.exit_date
        FROM employees e
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}} AND e.employment_status <> 'INACTIVE'
    `,
    orderBy: 'e.employee_code',
  },
]

export function findReportDefinition(key: string): ReportDefinition | undefined {
  return REPORT_DEFINITIONS.find((definition) => definition.key === key)
}
