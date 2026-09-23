import type { PermissionCode } from '../auth/permissions.js'
import { PERMISSIONS } from '../auth/permissions.js'

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

export type ColumnFormat = 'text' | 'number' | 'currency' | 'date' | 'days' | 'percent'

export interface ReportColumn {
  key: string
  label: string
  format: ColumnFormat
  /** Column totals are shown for currency and day columns when true. */
  total?: boolean
}

export type FilterKey =
  | 'from'
  | 'to'
  | 'year'
  | 'month'
  | 'departmentId'
  | 'supervisorId'
  | 'employeeId'
  | 'locationId'
  | 'employmentStatus'
  | 'attendanceStatus'
  | 'leaveStatus'
  | 'paymentStatus'
  | 'payrollRunId'

export interface ReportDefinition {
  key: string
  name: string
  description: string
  category: ReportCategory
  permission: PermissionCode
  columns: ReportColumn[]
  filters: FilterKey[]
  /** Filters without which the report is meaningless. */
  requiredFilters?: FilterKey[]
  /**
   * The SELECT ... FROM ... body. `{{scope}}` is replaced with the employee
   * scope predicate and `{{filters}}` with the bound filter predicates.
   */
  sql: string
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
    name: 'Monthly Attendance Summary',
    description: 'Per-employee attendance totals for a date range.',
    category: 'ATTENDANCE',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['from', 'to', 'departmentId', 'supervisorId'],
    requiredFilters: ['from', 'to'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'present_days', label: 'Present', format: 'days', total: true },
      { key: 'absent_days', label: 'Absent', format: 'days', total: true },
      { key: 'leave_days', label: 'Leave', format: 'days', total: true },
      { key: 'half_days', label: 'Half Day', format: 'days', total: true },
      { key: 'holiday_days', label: 'Holiday', format: 'days', total: true },
      { key: 'weekly_off_days', label: 'Weekly Off', format: 'days', total: true },
    ],
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             count(*) FILTER (WHERE a.status = 'PRESENT')        AS present_days,
             count(*) FILTER (WHERE a.status = 'ABSENT')         AS absent_days,
             count(*) FILTER (WHERE a.status = 'ON_LEAVE')       AS leave_days,
             count(*) FILTER (WHERE a.status = 'HALF_DAY_LEAVE') AS half_days,
             count(*) FILTER (WHERE a.status = 'HOLIDAY')        AS holiday_days,
             count(*) FILTER (WHERE a.status = 'WEEKLY_OFF')     AS weekly_off_days
        FROM employees e
        JOIN attendance a ON a.employee_id = e.id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}}
       GROUP BY e.id, e.employee_code, e.first_name, e.last_name, d.name, g.name
    `,
    orderBy: 'e.employee_code',
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
    description: 'The full payroll register for a month.',
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'departmentId', 'supervisorId', 'payrollRunId', 'paymentStatus'],
    requiredFilters: ['year', 'month'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'paid_days', label: 'Paid Days', format: 'days', total: true },
      { key: 'gross_earnings', label: 'Gross', format: 'currency', total: true },
      { key: 'total_bonus', label: 'Bonus', format: 'currency', total: true },
      { key: 'total_deductions', label: 'Deductions', format: 'currency', total: true },
      { key: 'net_salary', label: 'Net', format: 'currency', total: true },
      { key: 'paid_amount', label: 'Paid', format: 'currency', total: true },
      { key: 'pending_amount', label: 'Pending', format: 'currency', total: true },
      { key: 'payment_status', label: 'Payment Status', format: 'text' },
    ],
    sql: `
      SELECT i.employee_code,
             i.employee_name,
             i.department_name,
             i.designation_name,
             i.paid_days,
             i.gross_earnings,
             i.total_bonus,
             i.total_deductions,
             i.net_salary,
             i.paid_amount,
             i.pending_amount,
             i.payment_status::text AS payment_status
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'i.employee_code',
  },
  {
    key: 'payment-status',
    name: 'Payment Status Report',
    description: 'What has been paid and what is still outstanding for a month.',
    category: 'PAYMENT',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'departmentId', 'paymentStatus', 'payrollRunId'],
    requiredFilters: ['year', 'month'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'net_salary', label: 'Net Salary', format: 'currency', total: true },
      { key: 'paid_amount', label: 'Paid', format: 'currency', total: true },
      { key: 'pending_amount', label: 'Pending', format: 'currency', total: true },
      { key: 'payment_status', label: 'Status', format: 'text' },
      { key: 'last_payment_date', label: 'Last Payment', format: 'date' },
    ],
    sql: `
      SELECT i.employee_code,
             i.employee_name,
             i.department_name,
             i.designation_name,
             i.net_salary,
             i.paid_amount,
             i.pending_amount,
             i.payment_status::text AS payment_status,
             (SELECT max(t.payment_date) FROM payroll_payment_transactions t
               WHERE t.payroll_item_id = i.id AND t.reversed_at IS NULL) AS last_payment_date
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'i.payment_status, i.employee_code',
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
    key: 'bonus-report',
    name: 'Bonus Report',
    description: 'Bonuses by employee and payroll month.',
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'departmentId', 'employeeId'],
    requiredFilters: ['year'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'bonus_name', label: 'Bonus Name', format: 'text' },
      { key: 'amount', label: 'Amount', format: 'currency', total: true },
      { key: 'bonus_date', label: 'Bonus Date', format: 'date' },
      { key: 'status', label: 'Status', format: 'text' },
    ],
    sql: `
      SELECT e.employee_code,
             trim(e.first_name || ' ' || coalesce(e.last_name, '')) AS employee_name,
             d.name AS department_name,
             g.name AS designation_name,
             b.bonus_name,
             b.amount,
             b.bonus_date,
             b.status::text AS status
        FROM employee_bonuses b
        JOIN employees e ON e.id = b.employee_id
        LEFT JOIN departments  d ON d.id = e.department_id
        LEFT JOIN designations g ON g.id = e.designation_id
       WHERE {{scope}} {{filters}}
    `,
    orderBy: 'b.payroll_year DESC, b.payroll_month DESC, e.employee_code',
  },
  {
    key: 'tax-deductions-report',
    name: 'Panchayat Tax Report',
    description: 'Panchayat tax deducted from salary, by employee and payroll month.',
    category: 'STATUTORY',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'departmentId', 'employeeId'],
    requiredFilters: ['year'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'wage_base', label: 'Wages Charged On', format: 'currency', total: true },
      { key: 'tax_amount', label: 'Tax Amount', format: 'currency', total: true },
      { key: 'period_from', label: 'Wage Period From', format: 'date' },
      { key: 'period_to', label: 'Wage Period To', format: 'date' },
    ],
    sql: `
      SELECT e.employee_code,
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
    orderBy: 't.payroll_year DESC, t.payroll_month DESC, e.employee_code',
  },
  {
    key: 'other-deductions-report',
    name: 'Other Deductions Report',
    description: 'One-off deductions - penalties, recoveries and the like - by employee and payroll month.',
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'departmentId', 'employeeId'],
    requiredFilters: ['year'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'category', label: 'Category', format: 'text' },
      { key: 'amount', label: 'Amount', format: 'currency', total: true },
      { key: 'reason', label: 'Reason', format: 'text' },
      { key: 'status', label: 'Status', format: 'text' },
    ],
    sql: `
      SELECT e.employee_code,
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
    description: 'PL Wages eligibility and credit amount by employee and credit year.',
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
             c.status::text AS status
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
    filters: ['year', 'month', 'departmentId', 'payrollRunId'],
    requiredFilters: ['year', 'month'],
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'pf_number', label: 'PF Number', format: 'text' },
      { key: 'pf_name', label: 'Name (as per PF)', format: 'text' },
      { key: 'total_wages', label: 'Total Wages', format: 'currency', total: true },
      { key: 'pf_wage_ceiling', label: 'PF Wage Ceiling', format: 'currency' },
      { key: 'pf_covered_amount', label: 'PF Covered Amount', format: 'currency', total: true },
      { key: 'employee_contribution', label: 'Employee Contribution', format: 'currency', total: true },
      { key: 'employer_eps', label: 'Employer Contribution (EPS)', format: 'currency', total: true },
      { key: 'employer_epf', label: 'Employer Contribution (EPF)', format: 'currency', total: true },
      { key: 'leaves_taken', label: 'Leaves Taken', format: 'days', total: true },
      { key: 'pension_applicable', label: 'Pension (1/0)', format: 'number' },
    ],
    sql: `
      SELECT i.employee_code,
             i.employee_name,
             i.department_name,
             i.designation_name,
             coalesce(pf.pf_member_id, pf.uan_number) AS pf_number,
             coalesce(pf.pf_name, i.employee_name) AS pf_name,
             i.gross_earnings AS total_wages,
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
    orderBy: 'i.employee_code',
  },
  {
    key: 'esi-report',
    name: 'ESI Report',
    description: 'The ESIC monthly contribution upload format: one row per insured person covered under ESI.',
    category: 'STATUTORY',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'departmentId', 'payrollRunId'],
    requiredFilters: ['year', 'month'],
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
      SELECT esi.esi_number AS ip_number,
             coalesce(esi.esi_name, i.employee_name) AS ip_name,
             ceil(i.paid_days)::int AS days_paid,
             i.gross_earnings AS total_wages,
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
    orderBy: 'esi.esi_number',
  },
  {
    key: 'department-salary',
    name: 'Department Salary Report',
    description: 'Payroll totals grouped by department.',
    category: 'PAYROLL',
    permission: PERMISSIONS.REPORT_VIEW_ALL,
    employeeAlias: 'e',
    filters: ['year', 'month', 'payrollRunId'],
    requiredFilters: ['year', 'month'],
    columns: [
      { key: 'department_name', label: 'Department', format: 'text' },
      { key: 'employees', label: 'Employees', format: 'number', total: true },
      { key: 'gross_earnings', label: 'Gross', format: 'currency', total: true },
      { key: 'total_deductions', label: 'Deductions', format: 'currency', total: true },
      { key: 'net_salary', label: 'Net', format: 'currency', total: true },
      { key: 'paid_amount', label: 'Paid', format: 'currency', total: true },
      { key: 'pending_amount', label: 'Pending', format: 'currency', total: true },
    ],
    sql: `
      SELECT coalesce(i.department_name, 'Unassigned') AS department_name,
             count(*) AS employees,
             sum(i.gross_earnings)   AS gross_earnings,
             sum(i.total_deductions) AS total_deductions,
             sum(i.net_salary)       AS net_salary,
             sum(i.paid_amount)      AS paid_amount,
             sum(i.pending_amount)   AS pending_amount
        FROM payroll_items i
        JOIN payroll_runs r ON r.id = i.payroll_run_id
        JOIN employees e ON e.id = i.employee_id
       WHERE {{scope}} {{filters}}
       GROUP BY coalesce(i.department_name, 'Unassigned')
    `,
    orderBy: 'department_name',
  },
]

export function findReportDefinition(key: string): ReportDefinition | undefined {
  return REPORT_DEFINITIONS.find((definition) => definition.key === key)
}
