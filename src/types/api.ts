/** Shared API types, mirroring the server's response shapes. */

export type RoleKey = 'SUPER_ADMIN' | 'SUPERVISOR' | 'EMPLOYEE'

export type VerificationStatus = 'PENDING' | 'VERIFIED' | 'REJECTED'

export type EmploymentStatus = 'ACTIVE' | 'INACTIVE' | 'ON_NOTICE' | 'RESIGNED' | 'TERMINATED'

export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'TEMPORARY' | 'INTERN'

export type SalaryBasis = 'MONTHLY' | 'DAILY'

export type OvertimeHandling = 'OFF_IN_LIEU' | 'PAID_HOURLY'

/** A managed supply type. The overtime rule it carries is what payroll branches on. */
export interface EmployeeType {
  id: string
  name: string
  code: string
  description: string | null
  overtimeHandling: OvertimeHandling
  displayOrder: number
  isActive: boolean
  employeeCount?: number
}

export type PlantType = 'ULTRATECH' | 'ICL'

export type AttendanceStatus =
  | 'PRESENT'
  | 'ABSENT'
  | 'ON_LEAVE'
  | 'HALF_DAY_LEAVE'
  | 'HOLIDAY'
  | 'WEEKLY_OFF'

export type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'

export type PayrollRunStatus = 'DRAFT' | 'CALCULATED' | 'UNDER_REVIEW' | 'APPROVED' | 'LOCKED'

export type PaymentStatus = 'PENDING' | 'PARTIALLY_PAID' | 'PAID'

export type PaymentMethod = 'BANK_TRANSFER' | 'CASH' | 'CHEQUE' | 'UPI' | 'OTHER'

export interface SessionUser {
  id: string
  email: string
  fullName: string
  role: RoleKey
  organizationId: string
  employeeId: string | null
  employeeCode: string | null
  mustChangePassword: boolean
  permissions: string[]
  lastLoginAt: string | null
}

export interface AuthResult {
  user: SessionUser
  accessToken: string
  refreshToken: string
  refreshTokenExpiresAt: string
}

export interface OrganizationProfile {
  id: string
  name: string
  legalName: string | null
  code: string
  email: string | null
  phone: string | null
  website: string | null
  addressLine1: string | null
  city: string | null
  state: string | null
  pincode: string | null
  pfNumber: string | null
  esiNumber: string | null
  labourIdentificationNumber: string | null
  /** The logo key is never sent; it is fetched from /organization/logo. */
  hasLogo: boolean
  /** Doubles as the client's cache key for the logo. */
  logoUpdatedAt: string | null
  themeColor: string
  currencyCode: string
  timezone: string
}

export interface Department {
  id: string
  name: string
  code: string
  description: string | null
  parentDepartmentId: string | null
  headEmployeeId: string | null
  isActive: boolean
  employeeCount?: number
}

export interface Designation {
  id: string
  name: string
  code: string
  description: string | null
  departmentId: string | null
  level: number | null
  isActive: boolean
  employeeCount?: number
}

export interface Location {
  id: string
  name: string
  code: string
  city: string | null
  state: string | null
  isActive: boolean
  employeeCount?: number
}

export interface EmployeeSummary {
  id: string
  employeeCode: string
  firstName: string
  middleName: string | null
  lastName: string | null
  fullName: string
  workEmail: string | null
  personalEmail: string | null
  mobileNumber: string | null
  departmentId: string | null
  departmentName: string | null
  designationId: string | null
  designationName: string | null
  locationId: string | null
  locationName: string | null
  supervisorId: string | null
  supervisorName: string | null
  isSupervisor: boolean
  employmentType: EmploymentType
  employmentStatus: EmploymentStatus
  salaryBasis: SalaryBasis
  employeeTypeId: string
  employeeTypeName: string | null
  employeeTypeCode: string | null
  plant: PlantType | null
  overtimeRateOverride: number | null
  joiningDate: string
  exitDate: string | null
  userId: string | null
  userEmail: string | null
  userRole: RoleKey | null
  userStatus: string | null
  profileCompletionPercent?: number
}

export interface ProfileCompletionSection {
  section: string
  label: string
  complete: boolean
  verificationStatus: VerificationStatus | null
}

export interface ProfileCompletion {
  sections: ProfileCompletionSection[]
  completedSections: number
  totalSections: number
  completionPercent: number
  isComplete: boolean
}

export interface EmployeeAddress {
  id: string
  addressType: 'CURRENT' | 'PERMANENT'
  addressLine1: string
  addressLine2: string | null
  city: string
  state: string
  country: string
  pincode: string
}

export interface EmergencyContact {
  id: string
  name: string
  relationship: string
  phone: string
  alternatePhone: string | null
  address: string | null
  isPrimary: boolean
}

export interface EmployeeDetail extends EmployeeSummary {
  gender: string
  dateOfBirth: string | null
  maritalStatus: string
  bloodGroup: string | null
  parentName: string | null
  skillCategory: string | null
  duties: string | null
  alternateNumber: string | null
  confirmationDate: string | null
  noticeStartDate: string | null
  exitReason: string | null
  hasPhoto: boolean
  photoUpdatedAt: string | null
  addresses: EmployeeAddress[]
  emergencyContacts: EmergencyContact[]
  profileCompletion: ProfileCompletion
}

export interface EmployeeDocument {
  id: string
  employeeId: string
  category: string
  title: string
  originalFilename: string
  mimeType: string
  fileSizeBytes: number
  verificationStatus: VerificationStatus
  verifiedAt: string | null
  rejectionReason: string | null
  createdAt: string
  downloadPath: string
}

export interface IdentityProfile {
  pan: {
    id: string
    panNumber: string | null
    panMasked: string | null
    panName: string
    verificationStatus: VerificationStatus
    rejectionReason: string | null
  } | null
  aadhaar: {
    id: string
    aadhaarNumber: string | null
    aadhaarMasked: string | null
    aadhaarLast4: string
    aadhaarName: string
    verificationStatus: VerificationStatus
    rejectionReason: string | null
  } | null
  bankAccount: {
    id: string
    accountHolderName: string
    bankName: string
    accountNumber: string | null
    accountMasked: string | null
    accountLast4: string
    ifscCode: string
    branchName: string | null
    accountType: string
    verificationStatus: VerificationStatus
    rejectionReason: string | null
  } | null
  pf: {
    id: string
    pfApplicable: boolean
    uanNumber: string | null
    pfMemberId: string | null
    pfName: string | null
    pensionApplicable: boolean
    employeeContributionPercent: number | null
    employerContributionPercent: number | null
    verificationStatus: VerificationStatus
    rejectionReason: string | null
  } | null
  esi: {
    id: string
    esiApplicable: boolean
    esiNumber: string | null
    esiName: string | null
    employeeContributionPercent: number | null
    employerContributionPercent: number | null
    verificationStatus: VerificationStatus
    rejectionReason: string | null
  } | null
  documents: EmployeeDocument[]
  sensitiveVisible: boolean
}

export interface Shift {
  id: string
  name: string
  code: string
  startTime: string | null
  endTime: string | null
  breakMinutes: number
  isNightShift: boolean
  isActive: boolean
}

export interface DailySheetEmployee {
  employeeId: string
  employeeCode: string
  employeeName: string
  departmentId: string | null
  departmentName: string | null
  designationName: string | null
  supervisorId: string | null
  supervisorName: string | null
  attendanceId: string | null
  status: AttendanceStatus | null
  statusCode: string | null
  leaveTypeId: string | null
  leaveTypeName: string | null
  shiftId: string | null
  shiftCode: string | null
  shiftName: string | null
  remarks: string | null
  isLocked: boolean
  dayKind: 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY'
  holidayName: string | null
  suggestedStatus: AttendanceStatus
}

export interface DailySheet {
  date: string
  canManage: boolean
  summary: {
    total: number
    marked: number
    unmarked: number
    present: number
    absent: number
    onLeave: number
    halfDay: number
    holiday: number
    weeklyOff: number
  }
  employees: DailySheetEmployee[]
}

export type AttendanceImportFormat = 'MUSTER' | 'DAILY_PRESENT'
export type AttendanceImportConflictMode = 'OVERRIDE' | 'KEEP'

export interface AttendanceImportPreview {
  fileName: string
  format: AttendanceImportFormat
  sheetFrom: string
  sheetTo: string
  sheetDates: number
  peopleInSheet: number
  selectedFrom: string
  selectedTo: string
  /** ALL for an admin, TEAM for a supervisor (only their own reports are touched). */
  scope: 'ALL' | 'TEAM'
  summary: {
    create: number
    conflicts: number
    unchanged: number
    notEmployed: number
    locked: number
    protectedLeave: number
    unrecognisedCodes: number
    /** Absent marks on a paid holiday or weekly off, recorded as that day off. */
    absentAsDayOff: number
  }
  byDate: { date: string; create: number; conflict: number; unchanged: number }[]
  conflicts: {
    employeeCode: string
    employeeName: string
    date: string
    currentStatus: AttendanceStatus
    sheetStatus: AttendanceStatus
  }[]
  unknownEmployees: { total: number; items: { personId: string; name: string }[] }
  outOfScope: { total: number; items: { personId: string; name: string }[] }
  duplicates: number
}

export interface AttendanceImportResult {
  created: number
  overridden: number
  keptExisting: number
  unchanged: number
  skipped: {
    notEmployed: number
    locked: number
    protectedLeave: number
    unrecognisedCodes: number
    unknownEmployees: number
    outOfScope: number
  }
  from: string
  to: string
}

export interface MonthlyCalendarDay {
  date: string
  status: AttendanceStatus | null
  statusCode: string | null
  isMarked: boolean
  isEmployed: boolean
  dayKind: 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY'
  holidayName: string | null
  leaveTypeId: string | null
  remarks: string | null
  isLocked: boolean
}

export interface MonthlyCalendar {
  employee: { id: string; employeeCode: string; name: string }
  year: number
  month: number
  monthLabel: string
  from: string
  to: string
  workingDays: number
  counts: {
    present: number
    absent: number
    onLeave: number
    halfDayLeave: number
    holiday: number
    weeklyOff: number
    unmarked: number
  }
  days: MonthlyCalendarDay[]
}

export interface LeaveType {
  id: string
  name: string
  code: string
  description: string | null
  annualLimit: number | null
  isPaid: boolean
  requiresApproval: boolean
  allowHalfDay: boolean
  excludeWeeklyOff: boolean
  excludeHolidays: boolean
  sandwichHolidays: boolean
  maxConsecutiveDays: number | null
  requiresAttachment: boolean
  isActive: boolean
}

export interface LeaveBalance {
  id: string
  leaveTypeId: string
  leaveTypeName: string | null
  leaveTypeCode: string | null
  isPaid: boolean | null
  year: number
  entitled: number
  used: number
  pending: number
  available: number
}

export interface LeaveRequest {
  id: string
  employeeId: string
  employeeCode: string
  employeeName: string
  departmentName: string | null
  leaveTypeId: string
  leaveTypeName: string
  leaveTypeCode: string
  isPaid: boolean
  fromDate: string
  toDate: string
  dayPortion: 'FULL_DAY' | 'HALF_DAY'
  totalDays: number
  reason: string
  status: LeaveRequestStatus
  attachmentId: string | null
  decidedByName: string | null
  decidedAt: string | null
  decisionComment: string | null
  createdAt: string
  approvals?: { id: string; action: string; comment: string | null; created_at: string; approver_name: string | null }[]
}

export interface Holiday {
  id: string
  calendarId: string | null
  calendarName: string | null
  name: string
  holidayDate: string
  description: string | null
  isOptional: boolean
  isPaid: boolean
  /** Working this holiday earns one extra day's pay on top of the paid holiday. */
  extraPayIfWorked: boolean
}

export interface WeeklyOffRule {
  id: string
  name: string
  description: string | null
  departmentId: string | null
  locationId: string | null
  effectiveFrom: string
  effectiveTo: string | null
  priority: number
  isActive: boolean
  days: { weekday: string; occurrences: number[] | null; includeLast: boolean; isHalfDay: boolean }[]
}

export interface OvertimeEntry {
  id: string
  employeeId: string
  employeeCode?: string
  employeeName?: string
  departmentName?: string | null
  workDate: string
  hours: number
  remarks: string | null
  isLocked: boolean
  updatedAt: string
}

export interface OvertimeWeekSummary {
  weekStart: string
  weekEnd: string
  totalHours: number
  extraOffsEarned: number
  offDates: string[]
  warnings: string[]
}

export interface WeeklyOffCalendarDay {
  date: string
  weekday: string
  isWeeklyOff: boolean
}

export interface WeeklyOffCalendarEmployee {
  employeeId: string
  employeeCode: string
  employeeName: string
  departmentId: string | null
  departmentName: string | null
  supervisorId: string | null
  supervisorName: string | null
  days: WeeklyOffCalendarDay[]
}

export interface WeeklyOffCalendar {
  weekStart: string
  dates: string[]
  employees: WeeklyOffCalendarEmployee[]
}

export interface SalaryComponent {
  id: string
  name: string
  code: string
  isActive: boolean
}

export interface SalaryStructure {
  id: string
  name: string
  code: string
  description: string | null
  salaryBasis: SalaryBasis
  currencyCode: string
  isActive: boolean
  pfEmployeeRate: number
  pfEmployerRate: number
  pfWageCeiling: number
  pfEpsRate: number
  esiEmployeeRate: number
  esiEmployerRate: number
  esiWageLimit: number
  components: {
    id: string
    salaryComponentId: string
    name: string
    code: string
    componentType: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION'
    calculationType: 'FIXED' | 'PERCENTAGE'
    amount: number
    percentage: number
    displayOrder: number
  }[]
  summary: {
    fixedGross: number
    fixedDeductions: number
    fixedNet: number
    hasPercentageComponents: boolean
  }
}

export interface SalaryAssignment {
  id: string
  employeeId: string
  salaryStructureId: string
  structureName: string | null
  structureCode: string | null
  salaryBasis: SalaryBasis | null
  effectiveFrom: string
  effectiveTo: string | null
  status: string
  overrideAmount: number | null
  notes: string | null
  createdAt: string
}

export interface SalaryHistory {
  assignments: SalaryAssignment[]
  current: SalaryAssignment | null
  currentStructure: SalaryStructure | null
}

export interface PayrollRun {
  id: string
  year: number
  month: number
  monthLabel: string
  name: string | null
  status: PayrollRunStatus
  periodStart: string
  periodEnd: string
  totalEmployees: number
  totalGross: number
  totalDeductions: number
  totalNet: number
  totalPaid: number
  totalPending: number
  notes: string | null
  createdByName: string | null
  approvedByName: string | null
  createdAt: string
  calculatedAt: string | null
  approvedAt: string | null
  lockedAt: string | null
  isEditable: boolean
  isLocked: boolean
}

export interface PayrollAttendance {
  calendarDays: number
  workingDays: number
  presentDays: number
  absentDays: number
  leaveDays: number
  paidLeaveDays: number
  unpaidLeaveDays: number
  halfDayLeaveDays: number
  holidayDays: number
  weeklyOffDays: number
  unmarkedDays: number
  paidDays: number
  payableDaysBasis: number
}

export interface PayrollItem {
  id: string
  payrollRunId: string
  employeeId: string
  employeeCode: string
  employeeName: string
  departmentName: string | null
  designationName: string | null
  supervisorName: string | null
  salaryBasis: SalaryBasis
  salaryStructureName: string | null
  attendance: PayrollAttendance
  grossEarnings: number
  totalBonus: number
  totalDeductions: number
  employerContributions: number
  pfWage: number
  pfWageCeiling: number
  esiWage: number
  netSalary: number
  paidAmount: number
  pendingAmount: number
  paymentStatus: PaymentStatus
  remarks: string | null
  runStatus: PayrollRunStatus | null
  runYear: number | null
  runMonth: number | null
  /** PF/ESI split, present only on a run's item list. */
  contributions?: {
    pfEmployee: number
    esiEmployee: number
    /** Deductions other than PF and ESI (advances, fines, ...). */
    otherDeductions: number
    pfEmployerEpf: number
    pfEmployerEps: number
    /** EPF + EPS. */
    pfEmployer: number
    esiEmployer: number
  }
}

export interface PayrollComponent {
  id: string
  code: string
  name: string
  componentType: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION'
  calculationType: 'FIXED' | 'PERCENTAGE'
  source: string
  fullAmount: number
  amount: number
  percentage: number | null
  taxable: boolean
  displayOrder: number
  notes: string | null
}

export interface PayrollItemDetail extends PayrollItem {
  components: PayrollComponent[]
  earnings: PayrollComponent[]
  deductions: PayrollComponent[]
  /** Named distinctly from the numeric total on PayrollItem. */
  employerContributionComponents: PayrollComponent[]
}

export interface PaymentTransaction {
  id: string
  payrollItemId: string
  paymentDate: string
  amount: number
  paymentMethod: PaymentMethod
  referenceNumber: string | null
  notes: string | null
  isReversed: boolean
  reversedAt: string | null
  reversalReason: string | null
  /** The storage key is never sent; the file is fetched from /payments/:id/proof. */
  hasProof: boolean
  proofFilename: string | null
  proofUploadedAt: string | null
  createdByName: string | null
  createdAt: string
}

export interface PaymentLedger {
  payrollItemId: string
  employeeCode: string
  employeeName: string
  netSalary: number
  paidAmount: number
  pendingAmount: number
  paymentStatus: PaymentStatus
  payments: PaymentTransaction[]
}

export interface Payslip {
  id: string
  payrollItemId: string
  year: number
  month: number
  monthLabel: string
  netSalary: number
  paymentStatus: PaymentStatus
  fileSizeBytes: number
  generatedAt: string
  downloadPath: string
}

export interface Bonus {
  id: string
  employeeId: string
  employeeCode: string | null
  employeeName: string | null
  departmentName: string | null
  bonusName: string
  amount: number
  bonusDate: string
  payrollYear: number
  payrollMonth: number
  reason: string | null
  status: string
  wagePercentage: number | null
  wageBase: number | null
  manDays: number | null
  wagePeriodFrom: string | null
  wagePeriodTo: string | null
}

export interface PayrollAdjustment {
  id: string
  employeeId: string
  employeeCode: string | null
  employeeName: string | null
  adjustmentType: string
  componentCode: string
  componentName: string
  componentType: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION'
  amount: number
  applyYear: number
  applyMonth: number
  reason: string
  appliedAt: string | null
}

export interface LwfContribution {
  id: string
  employeeId: string
  employeeCode: string | null
  employeeName: string | null
  departmentName: string | null
  contributionYear: number
  employeeAmount: number
  employerAmount: number
  totalAmount: number
  payrollYear: number
  payrollMonth: number
  status: 'PENDING' | 'PAID'
  paidOn: string | null
  referenceNumber: string | null
  hasProof: boolean
  proofFilename: string | null
}

export interface PlWagesCredit {
  id: string
  employeeId: string
  employeeCode: string | null
  employeeName: string | null
  departmentName: string | null
  creditYear: number
  qualifyingMonths: number
  totalDaysWorked: number
  eligibleDays: number
  dailyWageRate: number
  creditAmount: number
  status: 'NOT_ELIGIBLE' | 'PENDING' | 'APPROVED' | 'PAID'
  payrollYear: number | null
  payrollMonth: number | null
  paidOn: string | null
}

export interface NotificationItem {
  id: string
  type: string
  title: string
  body: string
  link: string | null
  metadata: Record<string, unknown>
  isRead: boolean
  readAt: string | null
  createdAt: string
}

export interface AuditLogEntry {
  id: string
  action: string
  entityType: string
  entityId: string | null
  oldValues: unknown
  newValues: unknown
  ipAddress: string | null
  userName: string | null
  userEmail: string | null
  createdAt: string
}

export interface ReportColumn {
  key: string
  label: string
  format: 'text' | 'number' | 'currency' | 'date' | 'days' | 'percent'
  total?: boolean
}

export interface ReportDescriptor {
  key: string
  name: string
  description: string
  category: string
  columns: ReportColumn[]
  filters: string[]
  requiredFilters: string[]
}

export interface SuperAdminDashboard {
  role: 'SUPER_ADMIN'
  date: string
  headcount: { totalEmployees: number; activeEmployees: number; supervisors: number; onNotice: number }
  attendanceToday: { present: number; absent: number; onLeave: number; halfDay: number; holiday: number; weeklyOff: number }
  pendingLeaveRequests: number
  documents: { pendingVerification: number; employeesWithIncompleteProfiles: number }
  currentPayroll: {
    id: string
    year: number
    month: number
    monthLabel: string
    status: PayrollRunStatus
    totalEmployees: number
    grossSalary: number
    netSalary: number
    paid: number
    pending: number
    byPaymentStatus: Record<string, { count: number; amount: number }>
  } | null
  recentPayrollRuns: {
    id: string
    year: number
    month: number
    monthLabel: string
    status: PayrollRunStatus
    netSalary: number
    paid: number
    pending: number
  }[]
}

export interface SupervisorDashboard {
  role: 'SUPERVISOR'
  date: string
  team: { totalEmployees: number; activeEmployees: number }
  attendanceToday: { present: number; absent: number; onLeave: number; halfDay: number; holiday: number; weeklyOff: number }
  pendingLeaveRequests: number
  teamMembers: {
    id: string
    employeeCode: string
    name: string
    designationName: string | null
    todayStatus: AttendanceStatus | null
  }[]
}

export interface EmployeeDashboard {
  role: 'EMPLOYEE'
  date: string
  todayStatus: AttendanceStatus | null
  currentMonth: {
    year: number
    month: number
    monthLabel: string
    present: number
    absent: number
    onLeave: number
    halfDay: number
    holiday: number
    weeklyOff: number
  }
  leaveBalances: { leaveTypeName: string; entitled: number; used: number; pending: number; available: number }[]
  pendingLeaveRequests: number
  latestPayroll: {
    payrollItemId: string
    year: number
    month: number
    monthLabel: string
    netSalary: number
    paidAmount: number
    pendingAmount: number
    paymentStatus: PaymentStatus
  } | null
  latestPayslip: {
    id: string
    year: number
    month: number
    monthLabel: string
    generatedAt: string
    downloadPath: string
  } | null
  profileCompletion: ProfileCompletion
  unreadNotifications: number
}

export type DashboardData = SuperAdminDashboard | SupervisorDashboard | EmployeeDashboard
