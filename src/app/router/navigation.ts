import {
  BadgeIndianRupee,
  CalendarDays,
  ClipboardCheck,
  FileBarChart,
  FileText,
  Building2,
  HeartHandshake,
  Palmtree,
  LayoutDashboard,
  MessageSquare,
  MinusCircle,
  Landmark,
  ReceiptText,
  ScrollText,
  Settings,
  ShieldCheck,
  UserRound,
  UsersRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

/**
 * The navigation model (plan section 47).
 *
 * Each item declares the permissions it needs; the sidebar filters itself from
 * the signed-in user's permission set, so the three roles get the three
 * different menus the plan specifies without three hard-coded menus.
 */

export interface NavItem {
  label: string
  to: string
  icon?: LucideIcon
  /** Visible when the user holds any one of these. Empty means always visible. */
  anyOf?: string[]
  end?: boolean
}

export interface NavGroup {
  label: string
  items: NavItem[]
  /**
   * True for the group that shows a person their own records. Holding the
   * `.self` permissions is not enough to reach these - the account also has to
   * be linked to an employee. A Super Admin holds every permission but is an
   * administrative account with no employee record (plan sections 3 and 47),
   * so this group is hidden for them rather than leading to six error pages.
   */
  requiresEmployeeRecord?: boolean
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', to: '/', icon: LayoutDashboard, end: true }],
  },
  {
    label: 'People',
    items: [
      {
        label: 'Employees',
        to: '/employees',
        icon: UsersRound,
        anyOf: ['employee.view.all', 'employee.view.team'],
      },
      { label: 'Supervisors', to: '/supervisors', icon: ShieldCheck, anyOf: ['employee.view.all'] },
      {
        label: 'Documents',
        to: '/documents',
        icon: FileText,
        anyOf: ['document.view.all', 'document.view.team'],
      },
    ],
  },
  {
    label: 'Time',
    items: [
      {
        label: 'Attendance',
        to: '/attendance',
        icon: ClipboardCheck,
        anyOf: ['attendance.view.all', 'attendance.view.team'],
      },
      {
        label: 'Overtime',
        to: '/overtime',
        icon: ClipboardCheck,
        anyOf: ['overtime.view.all', 'overtime.view.team'],
      },
      {
        label: 'Leave',
        to: '/leave',
        icon: CalendarDays,
        anyOf: ['leave.view.all', 'leave.view.team', 'leave.approve.all', 'leave.approve.team'],
      },
      { label: 'Calendar', to: '/calendar', icon: CalendarDays, anyOf: ['holiday.view', 'weeklyoff.view'] },
    ],
  },
  {
    label: 'Payroll',
    items: [
      {
        label: 'Salary',
        to: '/salary',
        icon: BadgeIndianRupee,
        anyOf: ['salary.structure.view', 'salary.view.all'],
      },
      { label: 'Payroll runs', to: '/payroll', icon: Wallet, anyOf: ['payroll.view.all', 'payroll.view.team'] },
      { label: 'Payments', to: '/payments', icon: ReceiptText, anyOf: ['payment.view.all'] },
      { label: 'Payslips & letters', to: '/payslips-noc', icon: FileText, anyOf: ['payslip.view.all'] },
      { label: 'Bonuses', to: '/bonuses', icon: BadgeIndianRupee, anyOf: ['bonus.view'] },
      { label: 'Other Deductions', to: '/other-deductions', icon: MinusCircle, anyOf: ['payroll.adjust', 'payroll.view.all'] },
      { label: 'Panchayat Tax', to: '/tax', icon: Landmark, anyOf: ['tax.view'] },
      { label: 'Labour Welfare Fund', to: '/lwf', icon: HeartHandshake, anyOf: ['lwf.view'] },
      { label: 'PL Wages', to: '/pl-wages', icon: Palmtree, anyOf: ['plwages.view'] },
    ],
  },
  {
    label: 'My workspace',
    requiresEmployeeRecord: true,
    items: [
      { label: 'My profile', to: '/my-profile', icon: UserRound, anyOf: ['employee.view.self'] },
      { label: 'My attendance', to: '/my-attendance', icon: ClipboardCheck, anyOf: ['attendance.view.self'] },
      { label: 'My leave', to: '/my-leave', icon: CalendarDays, anyOf: ['leave.view.self'] },
      { label: 'My salary', to: '/my-salary', icon: Wallet, anyOf: ['salary.view.self', 'payroll.view.self'] },
      { label: 'My payslips', to: '/my-payslips', icon: ReceiptText, anyOf: ['payslip.view.self'] },
      { label: 'My documents', to: '/my-documents', icon: FileText, anyOf: ['document.view.self'] },
    ],
  },
  {
    label: 'Insights',
    items: [{ label: 'Reports', to: '/reports', icon: FileBarChart, anyOf: ['report.view.all', 'report.view.team'] }],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Organization', to: '/organization', icon: Building2, anyOf: ['org.view'] },
      { label: 'Users', to: '/users', icon: UsersRound, anyOf: ['user.view'] },
      { label: 'Messaging', to: '/messaging', icon: MessageSquare, anyOf: ['message.view'] },
      { label: 'Audit log', to: '/audit-logs', icon: ScrollText, anyOf: ['audit.view'] },
      { label: 'Settings', to: '/settings', icon: Settings, anyOf: ['settings.view'] },
    ],
  },
]

/** The five destinations offered on the mobile bottom bar. */
export const MOBILE_NAV: NavItem[] = [
  { label: 'Home', to: '/', icon: LayoutDashboard, end: true },
  {
    label: 'Attendance',
    to: '/attendance',
    icon: ClipboardCheck,
    anyOf: ['attendance.view.all', 'attendance.view.team'],
  },
  { label: 'My time', to: '/my-attendance', icon: ClipboardCheck, anyOf: ['attendance.view.self'] },
  { label: 'Leave', to: '/leave', icon: CalendarDays, anyOf: ['leave.view.all', 'leave.view.team'] },
  { label: 'My leave', to: '/my-leave', icon: CalendarDays, anyOf: ['leave.view.self'] },
  { label: 'Payroll', to: '/payroll', icon: Wallet, anyOf: ['payroll.view.all'] },
  { label: 'My pay', to: '/my-salary', icon: Wallet, anyOf: ['payroll.view.self'] },
  { label: 'Profile', to: '/my-profile', icon: UserRound, anyOf: ['employee.view.self'] },
]

export function filterNav(
  groups: NavGroup[],
  canAny: (...permissions: string[]) => boolean,
  hasEmployeeRecord = true,
): NavGroup[] {
  return groups
    .filter((group) => !group.requiresEmployeeRecord || hasEmployeeRecord)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.anyOf || item.anyOf.length === 0 || canAny(...item.anyOf)),
    }))
    .filter((group) => group.items.length > 0)
}

/** Routes on the mobile bar that need an employee record, not just permission. */
const SELF_ROUTES = new Set(['/my-attendance', '/my-leave', '/my-salary', '/my-profile'])

export function filterMobileNav(
  items: NavItem[],
  canAny: (...permissions: string[]) => boolean,
  limit = 5,
  hasEmployeeRecord = true,
): NavItem[] {
  return items
    .filter((item) => hasEmployeeRecord || !SELF_ROUTES.has(item.to))
    .filter((item) => !item.anyOf || item.anyOf.length === 0 || canAny(...item.anyOf))
    .slice(0, limit)
}
