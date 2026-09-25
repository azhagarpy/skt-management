/**
 * The permission catalogue.
 *
 * Permissions are the single source of truth for authorization (plan section 38).
 * Roles map to a default set; individual users can be granted or denied a
 * permission on top of that, which is how "supervisor may view team salary only
 * if explicitly permitted" (plan section 3) is expressed without a new role.
 *
 * The catalogue is synced into the `permissions` table on startup, so adding an
 * entry here is all that is needed to introduce a new permission.
 */

export const PERMISSIONS = {
  // Organization
  ORG_VIEW: 'org.view',
  ORG_MANAGE: 'org.manage',
  DEPARTMENT_VIEW: 'department.view',
  DEPARTMENT_MANAGE: 'department.manage',
  EMPLOYEE_TYPE_VIEW: 'employeeType.view',
  EMPLOYEE_TYPE_MANAGE: 'employeeType.manage',
  DESIGNATION_VIEW: 'designation.view',
  DESIGNATION_MANAGE: 'designation.manage',
  LOCATION_VIEW: 'location.view',
  LOCATION_MANAGE: 'location.manage',
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_MANAGE: 'settings.manage',

  // Users
  USER_VIEW: 'user.view',
  USER_MANAGE: 'user.manage',
  PERMISSION_MANAGE: 'permission.manage',

  // Employees
  EMPLOYEE_VIEW_ALL: 'employee.view.all',
  EMPLOYEE_VIEW_TEAM: 'employee.view.team',
  EMPLOYEE_VIEW_SELF: 'employee.view.self',
  EMPLOYEE_CREATE: 'employee.create',
  EMPLOYEE_UPDATE: 'employee.update',
  EMPLOYEE_UPDATE_SELF: 'employee.update.self',
  EMPLOYEE_DELETE: 'employee.delete',
  SUPERVISOR_MANAGE: 'supervisor.manage',

  // Documents and sensitive identity data
  DOCUMENT_VIEW_ALL: 'document.view.all',
  DOCUMENT_VIEW_TEAM: 'document.view.team',
  DOCUMENT_VIEW_SELF: 'document.view.self',
  DOCUMENT_UPLOAD_SELF: 'document.upload.self',
  DOCUMENT_UPLOAD_ANY: 'document.upload.any',
  DOCUMENT_VERIFY: 'document.verify',
  DOCUMENT_DELETE: 'document.delete',
  /** Reveals unmasked Aadhaar / PAN / bank account numbers. */
  SENSITIVE_DATA_VIEW: 'sensitive.view',

  // Attendance
  ATTENDANCE_VIEW_ALL: 'attendance.view.all',
  ATTENDANCE_VIEW_TEAM: 'attendance.view.team',
  ATTENDANCE_VIEW_SELF: 'attendance.view.self',
  ATTENDANCE_MANAGE_ALL: 'attendance.manage.all',
  ATTENDANCE_MANAGE_TEAM: 'attendance.manage.team',

  // Overtime
  OVERTIME_VIEW_ALL: 'overtime.view.all',
  OVERTIME_VIEW_TEAM: 'overtime.view.team',
  OVERTIME_VIEW_SELF: 'overtime.view.self',
  OVERTIME_MANAGE_ALL: 'overtime.manage.all',
  OVERTIME_MANAGE_TEAM: 'overtime.manage.team',

  // Leave
  LEAVE_VIEW_ALL: 'leave.view.all',
  LEAVE_VIEW_TEAM: 'leave.view.team',
  LEAVE_VIEW_SELF: 'leave.view.self',
  LEAVE_APPLY_SELF: 'leave.apply.self',
  LEAVE_APPROVE_ALL: 'leave.approve.all',
  LEAVE_APPROVE_TEAM: 'leave.approve.team',
  LEAVE_TYPE_MANAGE: 'leave.type.manage',
  LEAVE_POLICY_MANAGE: 'leave.policy.manage',
  LEAVE_BALANCE_MANAGE: 'leave.balance.manage',

  // Calendar
  HOLIDAY_VIEW: 'holiday.view',
  HOLIDAY_MANAGE: 'holiday.manage',
  WEEKLY_OFF_VIEW: 'weeklyoff.view',
  WEEKLY_OFF_MANAGE: 'weeklyoff.manage',
  WEEKLY_OFF_ASSIGN_TEAM: 'weeklyoff.assign.team',
  SHIFT_MANAGE: 'shift.manage',

  // Salary
  SALARY_STRUCTURE_VIEW: 'salary.structure.view',
  SALARY_STRUCTURE_MANAGE: 'salary.structure.manage',
  SALARY_VIEW_ALL: 'salary.view.all',
  SALARY_VIEW_TEAM: 'salary.view.team',
  SALARY_VIEW_SELF: 'salary.view.self',
  SALARY_MANAGE: 'salary.manage',

  // Bonuses and tax
  BONUS_VIEW: 'bonus.view',
  BONUS_MANAGE: 'bonus.manage',
  TAX_VIEW: 'tax.view',
  TAX_MANAGE: 'tax.manage',
  LWF_VIEW: 'lwf.view',
  LWF_MANAGE: 'lwf.manage',
  PL_WAGES_VIEW: 'plwages.view',
  PL_WAGES_MANAGE: 'plwages.manage',

  // Payroll
  PAYROLL_VIEW_ALL: 'payroll.view.all',
  PAYROLL_VIEW_TEAM: 'payroll.view.team',
  PAYROLL_VIEW_SELF: 'payroll.view.self',
  PAYROLL_PROCESS: 'payroll.process',
  PAYROLL_APPROVE: 'payroll.approve',
  PAYROLL_LOCK: 'payroll.lock',
  PAYROLL_ADJUST: 'payroll.adjust',
  PAYROLL_DELETE: 'payroll.delete',

  // Payments
  PAYMENT_VIEW_ALL: 'payment.view.all',
  PAYMENT_VIEW_SELF: 'payment.view.self',
  PAYMENT_MANAGE: 'payment.manage',

  // Payslips
  PAYSLIP_VIEW_ALL: 'payslip.view.all',
  PAYSLIP_VIEW_SELF: 'payslip.view.self',
  PAYSLIP_GENERATE: 'payslip.generate',

  // Reports
  REPORT_VIEW_ALL: 'report.view.all',
  REPORT_VIEW_TEAM: 'report.view.team',
  REPORT_EXPORT: 'report.export',

  // Messaging
  MESSAGE_VIEW: 'message.view',
  MESSAGE_MANAGE: 'message.manage',
  MESSAGE_BROADCAST: 'message.broadcast',

  // Audit
  AUDIT_VIEW: 'audit.view',
} as const

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

export interface PermissionDefinition {
  code: PermissionCode
  module: string
  description: string
}

const define = (code: PermissionCode, module: string, description: string): PermissionDefinition => ({
  code,
  module,
  description,
})

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  define(PERMISSIONS.ORG_VIEW, 'organization', 'View organization profile'),
  define(PERMISSIONS.ORG_MANAGE, 'organization', 'Update organization profile'),
  define(PERMISSIONS.DEPARTMENT_VIEW, 'organization', 'View departments'),
  define(PERMISSIONS.DEPARTMENT_MANAGE, 'organization', 'Create, update and delete departments'),
  define(PERMISSIONS.EMPLOYEE_TYPE_VIEW, 'organization', 'View supply types'),
  define(PERMISSIONS.EMPLOYEE_TYPE_MANAGE, 'organization', 'Create, update and delete supply types'),
  define(PERMISSIONS.DESIGNATION_VIEW, 'organization', 'View sections'),
  define(PERMISSIONS.DESIGNATION_MANAGE, 'organization', 'Create, update and delete sections'),
  define(PERMISSIONS.LOCATION_VIEW, 'organization', 'View locations'),
  define(PERMISSIONS.LOCATION_MANAGE, 'organization', 'Create, update and delete locations'),
  define(PERMISSIONS.SETTINGS_VIEW, 'settings', 'View system settings'),
  define(PERMISSIONS.SETTINGS_MANAGE, 'settings', 'Change system settings'),

  define(PERMISSIONS.USER_VIEW, 'users', 'View user accounts'),
  define(PERMISSIONS.USER_MANAGE, 'users', 'Create, update and deactivate user accounts'),
  define(PERMISSIONS.PERMISSION_MANAGE, 'users', 'Grant and revoke individual permissions'),

  define(PERMISSIONS.EMPLOYEE_VIEW_ALL, 'employees', 'View every employee in the organization'),
  define(PERMISSIONS.EMPLOYEE_VIEW_TEAM, 'employees', 'View assigned employees only'),
  define(PERMISSIONS.EMPLOYEE_VIEW_SELF, 'employees', 'View own employee profile'),
  define(PERMISSIONS.EMPLOYEE_CREATE, 'employees', 'Create employees'),
  define(PERMISSIONS.EMPLOYEE_UPDATE, 'employees', 'Update any employee'),
  define(PERMISSIONS.EMPLOYEE_UPDATE_SELF, 'employees', 'Update own allowed personal information'),
  define(PERMISSIONS.EMPLOYEE_DELETE, 'employees', 'Delete employees'),
  define(PERMISSIONS.SUPERVISOR_MANAGE, 'employees', 'Manage supervisors and their assignments'),

  define(PERMISSIONS.DOCUMENT_VIEW_ALL, 'documents', 'View any employee document'),
  define(PERMISSIONS.DOCUMENT_VIEW_TEAM, 'documents', 'View documents of assigned employees'),
  define(PERMISSIONS.DOCUMENT_VIEW_SELF, 'documents', 'View own documents'),
  define(PERMISSIONS.DOCUMENT_UPLOAD_SELF, 'documents', 'Upload own documents'),
  define(PERMISSIONS.DOCUMENT_UPLOAD_ANY, 'documents', 'Upload documents on behalf of any employee'),
  define(PERMISSIONS.DOCUMENT_VERIFY, 'documents', 'Verify or reject submitted documents'),
  define(PERMISSIONS.DOCUMENT_DELETE, 'documents', 'Delete employee documents'),
  define(PERMISSIONS.SENSITIVE_DATA_VIEW, 'documents', 'View unmasked Aadhaar, PAN and bank account numbers'),

  define(PERMISSIONS.ATTENDANCE_VIEW_ALL, 'attendance', 'View attendance for every employee'),
  define(PERMISSIONS.ATTENDANCE_VIEW_TEAM, 'attendance', 'View attendance for assigned employees'),
  define(PERMISSIONS.ATTENDANCE_VIEW_SELF, 'attendance', 'View own attendance'),
  define(PERMISSIONS.ATTENDANCE_MANAGE_ALL, 'attendance', 'Mark and edit attendance for every employee'),
  define(PERMISSIONS.ATTENDANCE_MANAGE_TEAM, 'attendance', 'Mark and edit attendance for assigned employees'),

  define(PERMISSIONS.OVERTIME_VIEW_ALL, 'overtime', 'View overtime for every employee'),
  define(PERMISSIONS.OVERTIME_VIEW_TEAM, 'overtime', 'View overtime for assigned employees'),
  define(PERMISSIONS.OVERTIME_VIEW_SELF, 'overtime', 'View own overtime'),
  define(PERMISSIONS.OVERTIME_MANAGE_ALL, 'overtime', 'Record overtime for every employee'),
  define(PERMISSIONS.OVERTIME_MANAGE_TEAM, 'overtime', 'Record overtime for assigned employees'),

  define(PERMISSIONS.LEAVE_VIEW_ALL, 'leave', 'View every leave request'),
  define(PERMISSIONS.LEAVE_VIEW_TEAM, 'leave', 'View leave requests of assigned employees'),
  define(PERMISSIONS.LEAVE_VIEW_SELF, 'leave', 'View own leave'),
  define(PERMISSIONS.LEAVE_APPLY_SELF, 'leave', 'Apply for leave'),
  define(PERMISSIONS.LEAVE_APPROVE_ALL, 'leave', 'Approve or reject any leave request'),
  define(PERMISSIONS.LEAVE_APPROVE_TEAM, 'leave', 'Approve or reject leave for assigned employees'),
  define(PERMISSIONS.LEAVE_TYPE_MANAGE, 'leave', 'Manage leave types'),
  define(PERMISSIONS.LEAVE_POLICY_MANAGE, 'leave', 'Manage leave policies'),
  define(PERMISSIONS.LEAVE_BALANCE_MANAGE, 'leave', 'Adjust leave balances'),

  define(PERMISSIONS.HOLIDAY_VIEW, 'calendar', 'View holidays'),
  define(PERMISSIONS.HOLIDAY_MANAGE, 'calendar', 'Configure holidays'),
  define(PERMISSIONS.WEEKLY_OFF_VIEW, 'calendar', 'View weekly off configuration'),
  define(PERMISSIONS.WEEKLY_OFF_MANAGE, 'calendar', 'Configure weekly offs for any employee'),
  define(PERMISSIONS.WEEKLY_OFF_ASSIGN_TEAM, 'calendar', 'Assign a weekly off to employees on their own team'),
  define(PERMISSIONS.SHIFT_MANAGE, 'calendar', 'Manage shifts'),

  define(PERMISSIONS.SALARY_STRUCTURE_VIEW, 'salary', 'View salary structures'),
  define(PERMISSIONS.SALARY_STRUCTURE_MANAGE, 'salary', 'Create and update salary structures'),
  define(PERMISSIONS.SALARY_VIEW_ALL, 'salary', 'View salary of every employee'),
  define(PERMISSIONS.SALARY_VIEW_TEAM, 'salary', 'View salary of assigned employees'),
  define(PERMISSIONS.SALARY_VIEW_SELF, 'salary', 'View own salary'),
  define(PERMISSIONS.SALARY_MANAGE, 'salary', 'Assign and revise employee salaries'),

  define(PERMISSIONS.BONUS_VIEW, 'bonus', 'View bonuses'),
  define(PERMISSIONS.BONUS_MANAGE, 'bonus', 'Add and update bonuses'),
  define(PERMISSIONS.TAX_VIEW, 'tax', 'View tax slabs and the tax report'),
  define(PERMISSIONS.TAX_MANAGE, 'tax', 'Change the tax slabs'),
  define(PERMISSIONS.LWF_VIEW, 'lwf', 'View Labour Welfare Fund contributions'),
  define(PERMISSIONS.LWF_MANAGE, 'lwf', 'Generate and mark Labour Welfare Fund contributions as paid'),
  define(PERMISSIONS.PL_WAGES_VIEW, 'pl-wages', 'View PL Wages credits'),
  define(PERMISSIONS.PL_WAGES_MANAGE, 'pl-wages', 'Generate, release and mark PL Wages credits as paid'),

  define(PERMISSIONS.PAYROLL_VIEW_ALL, 'payroll', 'View every payroll run and item'),
  define(PERMISSIONS.PAYROLL_VIEW_TEAM, 'payroll', 'View payroll for assigned employees'),
  define(PERMISSIONS.PAYROLL_VIEW_SELF, 'payroll', 'View own payroll'),
  define(PERMISSIONS.PAYROLL_PROCESS, 'payroll', 'Create and calculate payroll runs'),
  define(PERMISSIONS.PAYROLL_APPROVE, 'payroll', 'Approve payroll runs'),
  define(PERMISSIONS.PAYROLL_LOCK, 'payroll', 'Lock payroll runs'),
  define(PERMISSIONS.PAYROLL_ADJUST, 'payroll', 'Raise adjustments against locked payroll'),
  define(PERMISSIONS.PAYROLL_DELETE, 'payroll', 'Delete a draft payroll run that has not been processed'),

  define(PERMISSIONS.PAYMENT_VIEW_ALL, 'payments', 'View every payment transaction'),
  define(PERMISSIONS.PAYMENT_VIEW_SELF, 'payments', 'View own payment status'),
  define(PERMISSIONS.PAYMENT_MANAGE, 'payments', 'Record and reverse salary payments'),

  define(PERMISSIONS.PAYSLIP_VIEW_ALL, 'payslips', 'View every payslip'),
  define(PERMISSIONS.PAYSLIP_VIEW_SELF, 'payslips', 'View and download own payslips'),
  define(PERMISSIONS.PAYSLIP_GENERATE, 'payslips', 'Generate payslips'),

  define(PERMISSIONS.REPORT_VIEW_ALL, 'reports', 'View all reports'),
  define(PERMISSIONS.REPORT_VIEW_TEAM, 'reports', 'View reports scoped to assigned employees'),
  define(PERMISSIONS.REPORT_EXPORT, 'reports', 'Export reports to CSV, Excel and PDF'),

  define(PERMISSIONS.MESSAGE_VIEW, 'messaging', 'View message scenarios and the delivery log'),
  define(PERMISSIONS.MESSAGE_MANAGE, 'messaging', 'Configure which events send a WhatsApp message'),
  define(PERMISSIONS.MESSAGE_BROADCAST, 'messaging', 'Send a message to a chosen set of people'),

  define(PERMISSIONS.AUDIT_VIEW, 'audit', 'View audit logs'),
]

export type RoleKey = 'SUPER_ADMIN' | 'SUPERVISOR' | 'EMPLOYEE'

/** Super Admin holds every permission in the catalogue (plan section 3). */
const SUPER_ADMIN_PERMISSIONS: PermissionCode[] = PERMISSION_DEFINITIONS.map((definition) => definition.code)

/**
 * Supervisors manage their own team only. Team salary, team payroll and team
 * reports are *not* included by default - they must be granted per user, exactly
 * as the plan specifies ("only if explicitly permitted").
 */
const SUPERVISOR_PERMISSIONS: PermissionCode[] = [
  PERMISSIONS.ORG_VIEW,
  PERMISSIONS.DEPARTMENT_VIEW,
  PERMISSIONS.DESIGNATION_VIEW,
  PERMISSIONS.EMPLOYEE_TYPE_VIEW,
  PERMISSIONS.LOCATION_VIEW,

  PERMISSIONS.EMPLOYEE_VIEW_TEAM,
  PERMISSIONS.EMPLOYEE_VIEW_SELF,
  PERMISSIONS.EMPLOYEE_UPDATE_SELF,

  PERMISSIONS.DOCUMENT_VIEW_TEAM,
  PERMISSIONS.DOCUMENT_VIEW_SELF,
  PERMISSIONS.DOCUMENT_UPLOAD_SELF,

  PERMISSIONS.ATTENDANCE_VIEW_TEAM,
  PERMISSIONS.ATTENDANCE_VIEW_SELF,
  PERMISSIONS.ATTENDANCE_MANAGE_TEAM,

  PERMISSIONS.OVERTIME_VIEW_TEAM,
  PERMISSIONS.OVERTIME_VIEW_SELF,
  PERMISSIONS.OVERTIME_MANAGE_TEAM,

  PERMISSIONS.LEAVE_VIEW_TEAM,
  PERMISSIONS.LEAVE_VIEW_SELF,
  PERMISSIONS.LEAVE_APPLY_SELF,
  PERMISSIONS.LEAVE_APPROVE_TEAM,

  PERMISSIONS.HOLIDAY_VIEW,
  PERMISSIONS.WEEKLY_OFF_VIEW,
  PERMISSIONS.WEEKLY_OFF_ASSIGN_TEAM,

  PERMISSIONS.SALARY_VIEW_SELF,
  PERMISSIONS.PAYROLL_VIEW_SELF,
  PERMISSIONS.PAYMENT_VIEW_SELF,
  PERMISSIONS.PAYSLIP_VIEW_SELF,

  PERMISSIONS.REPORT_VIEW_TEAM,
]

/** Employees only ever reach their own records (plan section 3). */
const EMPLOYEE_PERMISSIONS: PermissionCode[] = [
  PERMISSIONS.ORG_VIEW,
  PERMISSIONS.DEPARTMENT_VIEW,
  PERMISSIONS.DESIGNATION_VIEW,
  PERMISSIONS.EMPLOYEE_TYPE_VIEW,

  PERMISSIONS.EMPLOYEE_VIEW_SELF,
  PERMISSIONS.EMPLOYEE_UPDATE_SELF,

  PERMISSIONS.DOCUMENT_VIEW_SELF,
  PERMISSIONS.DOCUMENT_UPLOAD_SELF,

  PERMISSIONS.ATTENDANCE_VIEW_SELF,

  PERMISSIONS.OVERTIME_VIEW_SELF,

  PERMISSIONS.LEAVE_VIEW_SELF,
  PERMISSIONS.LEAVE_APPLY_SELF,

  PERMISSIONS.HOLIDAY_VIEW,
  PERMISSIONS.WEEKLY_OFF_VIEW,

  PERMISSIONS.SALARY_VIEW_SELF,
  PERMISSIONS.PAYROLL_VIEW_SELF,
  PERMISSIONS.PAYMENT_VIEW_SELF,
  PERMISSIONS.PAYSLIP_VIEW_SELF,
]

export const ROLE_PERMISSIONS: Record<RoleKey, PermissionCode[]> = {
  SUPER_ADMIN: SUPER_ADMIN_PERMISSIONS,
  SUPERVISOR: SUPERVISOR_PERMISSIONS,
  EMPLOYEE: EMPLOYEE_PERMISSIONS,
}

export const ROLE_LABELS: Record<RoleKey, string> = {
  SUPER_ADMIN: 'Super Admin',
  SUPERVISOR: 'Supervisor',
  EMPLOYEE: 'Employee',
}
