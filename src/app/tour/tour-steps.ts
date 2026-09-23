import type { RoleKey } from '../../types/api'

/**
 * The first-run product tour (one step per module).
 *
 * Steps are written once as a superset and filtered at runtime to those whose
 * target is actually on screen. The sidebar is already built from the signed-in
 * user's permissions, so that filter gives each role - and each per-user
 * permission grant - the right tour without three hard-coded scripts.
 */

export interface TourStep {
  id: string
  /** CSS selector for the element to spotlight. Omit for a centred card. */
  target?: string
  title: string
  body: string
  /** Shown for these roles only. Omit for all roles. */
  roles?: RoleKey[]
}

const navTarget = (route: string): string => `[data-tour-nav="${route}"]`

/** Role-specific opening card. */
const WELCOME: Record<RoleKey, TourStep> = {
  SUPER_ADMIN: {
    id: 'welcome',
    title: 'Welcome — you run this workspace',
    body:
      'You can see and change everything here. This short tour walks the sidebar top to bottom so you know what each module is for. It takes about a minute.',
  },
  SUPERVISOR: {
    id: 'welcome',
    title: 'Welcome — here is your team',
    body:
      'You manage the people assigned to you: their attendance, their leave, their documents. This short tour shows you where each of those lives.',
  },
  EMPLOYEE: {
    id: 'welcome',
    title: 'Welcome — this is your workspace',
    body:
      'Everything here is yours: your attendance, your leave, your payslips. This short tour shows you where to find each one.',
  },
}

/** Role-specific closing card, with the one thing to do first. */
const FINISH: Record<RoleKey, TourStep> = {
  SUPER_ADMIN: {
    id: 'finish',
    title: 'Where to start',
    body:
      'Set up in this order: Organization (departments, sections, locations) → Salary (components, then structures) → Calendar (holidays and weekly offs) → Employees → assign each a salary. Payroll needs all of it before it can calculate a month.',
  },
  SUPERVISOR: {
    id: 'finish',
    title: 'Where to start',
    body:
      'Open Attendance and mark today for your team, then check Leave for anything waiting on your approval. Both are scoped to the people assigned to you.',
  },
  EMPLOYEE: {
    id: 'finish',
    title: 'Where to start',
    body:
      'Check My profile is correct and upload any documents you have been asked for. Apply for leave from My leave whenever you need to.',
  },
}

/**
 * The module walkthrough, in sidebar order. Anything the signed-in user cannot
 * reach is dropped automatically because its nav item will not be rendered.
 */
const MODULE_STEPS: TourStep[] = [
  {
    id: 'sidebar',
    target: '[data-tour="sidebar"]',
    title: 'Your menu',
    body:
      'Every module lives here, grouped by what it does. You only see what your permissions allow, so this menu is already your menu — nothing is hidden behind a locked door.',
  },
  {
    id: 'dashboard',
    target: navTarget('/'),
    title: 'Dashboard',
    body:
      'Where you land each day. A summary of what needs attention — pending approvals, today’s attendance and the state of the current payroll month.',
  },
  {
    id: 'employees',
    target: navTarget('/employees'),
    title: 'Employees',
    body:
      'Everyone in the organization. Here you can create employees — name, department, section, joining date, supervisor — and open any record to manage their identity, documents and salary.',
    roles: ['SUPER_ADMIN', 'SUPERVISOR'],
  },
  {
    id: 'supervisors',
    target: navTarget('/supervisors'),
    title: 'Supervisors',
    body:
      'Who manages whom. Assign employees to a supervisor here — that assignment is what scopes a supervisor’s attendance, leave and reports to their own team.',
  },
  {
    id: 'documents',
    target: navTarget('/documents'),
    title: 'Documents',
    body:
      'The review queue. People upload their own ID and proofs; here you verify or reject each one. Aadhaar, PAN and bank numbers stay masked unless you have permission to reveal them.',
  },
  {
    id: 'attendance',
    target: navTarget('/attendance'),
    title: 'Attendance',
    body:
      'Mark who was present, one day at a time or in bulk for a whole month. Every day resolves to present, absent, on leave, half day, holiday or weekly off — and payroll reads exactly this.',
  },
  {
    id: 'leave',
    target: navTarget('/leave'),
    title: 'Leave',
    body:
      'Approve or reject requests. An approved request writes itself back into attendance. Leave types are configured here too — whether a type is paid decides how payroll values those days.',
  },
  {
    id: 'calendar',
    target: navTarget('/calendar'),
    title: 'Calendar',
    body:
      'Holidays and weekly offs. This defines what a working day actually is, so set it before you run a payroll month — otherwise every day counts as a working day.',
    roles: ['SUPER_ADMIN'],
  },
  {
    id: 'calendar-read',
    target: navTarget('/calendar'),
    title: 'Calendar',
    body:
      'The company holiday list and the weekly off pattern. Worth checking before you apply for leave — holidays and weekly offs inside your dates usually do not use up your balance.',
    roles: ['SUPERVISOR', 'EMPLOYEE'],
  },
  {
    id: 'salary',
    target: navTarget('/salary'),
    title: 'Salary',
    body:
      'Build salary components first, assemble them into structures, then assign a structure to each employee. PF, ESI and payroll policy live here as well. An employee with no salary assigned produces no payroll line.',
  },
  {
    id: 'payroll',
    target: navTarget('/payroll'),
    title: 'Payroll runs',
    body:
      'Create a run for a year and month, then calculate it. A run moves draft → calculated → approved → locked, and stays editable until you approve it. Locking closes the month for good.',
  },
  {
    id: 'payments',
    target: navTarget('/payments'),
    title: 'Payments',
    body:
      'Record what has actually been paid, against an approved or locked run. Payments track separately from the run: pending, partially paid, then paid.',
  },
  {
    id: 'bonuses',
    target: navTarget('/bonuses'),
    title: 'Bonuses',
    body:
      'Add a bonus to a payroll month rather than a date. Only approved bonuses are picked up when that month is calculated — a pending one is ignored.',
  },
  {
    id: 'other-deductions',
    target: navTarget('/other-deductions'),
    title: 'Other Deductions',
    body:
      'A one-off deduction for a chosen payroll month - a penalty, a recovery for damaged or lost property, an advance recovery, or anything else. It is applied automatically when that month’s payroll is calculated, and can be removed up until then.',
  },
  {
    id: 'tax',
    target: navTarget('/tax'),
    title: 'Panchayat Tax',
    body:
      'Set the Panchayat tax amount for each band of wages, then run the tax report for a half-year: every employee’s monthly wages, their total, and the tax that total falls under. Choose the payroll month the tax comes out of pay, and payroll deducts it as P.Tax.',
  },
  {
    id: 'lwf',
    target: navTarget('/lwf'),
    title: 'Labour Welfare Fund',
    body:
      'Generate a row for every active employee once a year: a fixed amount from the employee, deducted through payroll, plus a matching amount from the employer that is only tracked here. Once it has actually been paid to the government, mark it paid with a reference number and, optionally, a proof document.',
  },
  {
    id: 'pl-wages',
    target: navTarget('/pl-wages'),
    title: 'PL Wages',
    body:
      'Generate once a year: anyone who worked at least 20 days in 3 or more separate months earns 1 day’s wage for every 20 days worked across the year. Review the batch, release it into a payroll month, and mark it paid once that run is settled.',
  },
  {
    id: 'my-profile',
    target: navTarget('/my-profile'),
    title: 'My profile',
    body:
      'Your own record. Update the personal details you are allowed to change, and upload the documents you have been asked for.',
  },
  {
    id: 'my-attendance',
    target: navTarget('/my-attendance'),
    title: 'My attendance',
    body: 'Your own month, day by day, as it was marked — including your leave, holidays and weekly offs.',
  },
  {
    id: 'my-leave',
    target: navTarget('/my-leave'),
    title: 'My leave',
    body:
      'Apply for leave here, and watch it move from pending to approved. Your remaining balance for each leave type is shown alongside.',
  },
  {
    id: 'my-salary',
    target: navTarget('/my-salary'),
    title: 'My salary',
    body: 'What you are paid, broken down by component, and the status of the current month.',
  },
  {
    id: 'my-payslips',
    target: navTarget('/my-payslips'),
    title: 'My payslips',
    body: 'Download a payslip for any month. One appears once that month’s payroll has been approved.',
  },
  {
    id: 'my-documents',
    target: navTarget('/my-documents'),
    title: 'My documents',
    body:
      'Upload what you have been asked for — ID, proofs, certificates. Each one shows whether it is still pending review, verified or rejected.',
  },
  {
    id: 'reports',
    target: navTarget('/reports'),
    title: 'Reports',
    body:
      'Attendance, leave, salary and payroll, exported to CSV, Excel or PDF. Supervisors get the same reports narrowed to their own team.',
  },
  {
    id: 'organization',
    target: navTarget('/organization'),
    title: 'Organization',
    body:
      'Your company profile, and the lists everything else is filed under — departments, sections and locations. The Branding tab sets the logo and accent colour for the whole app.',
    roles: ['SUPER_ADMIN'],
  },
  {
    id: 'organization-read',
    target: navTarget('/organization'),
    title: 'Organization',
    body:
      'Company details, and the departments, sections and locations people are assigned to. You can look, but changing any of it is an administrator’s job.',
    roles: ['SUPERVISOR', 'EMPLOYEE'],
  },
  {
    id: 'users',
    target: navTarget('/users'),
    title: 'Users',
    body:
      'Login accounts and roles. You can also grant or revoke a single permission for one person here — that is how a supervisor gets access to team salary without changing their role.',
  },
  {
    id: 'audit',
    target: navTarget('/audit-logs'),
    title: 'Audit log',
    body: 'Who changed what, when, and from where. Every important change is recorded, including revealing a masked number.',
  },
  {
    id: 'settings',
    target: navTarget('/settings'),
    title: 'Settings',
    body: 'System-wide settings for the workspace.',
  },
  {
    id: 'notifications',
    target: '[data-tour="notifications"]',
    title: 'Notifications',
    body: 'Anything that needs you — a leave request waiting, a document to verify, a payroll run ready for review.',
  },
  {
    id: 'account',
    target: '[data-tour="account"]',
    title: 'Your account',
    body: 'Change your password or sign out here. You can also replay this tour from this menu whenever you like.',
  },
]

/** The full script for a role, before the on-screen filter is applied. */
export function tourScript(role: RoleKey): TourStep[] {
  const modules = MODULE_STEPS.filter((step) => !step.roles || step.roles.includes(role))
  return [WELCOME[role], ...modules, FINISH[role]]
}
