import { Suspense, lazy, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from '../providers/AuthProvider'
import { AppLayout } from '../../layouts/AppLayout'
import { EmptyState, Spinner } from '../../components/ui'

/**
 * Routing.
 *
 * Every feature page is code-split (plan section 59), and every protected route
 * is wrapped in a guard that checks permissions rather than roles, so the
 * per-user permission overrides take effect in the UI as well as the API.
 */

const LoginPage = lazy(() => import('../../features/auth/LoginPage'))
const ForgotPasswordPage = lazy(() => import('../../features/auth/ForgotPasswordPage'))
const ResetPasswordPage = lazy(() => import('../../features/auth/ResetPasswordPage'))
const ChangePasswordPage = lazy(() => import('../../features/auth/ChangePasswordPage'))

const DashboardPage = lazy(() => import('../../features/dashboard/DashboardPage'))
const EmployeeListPage = lazy(() => import('../../features/employees/EmployeeListPage'))
const EmployeeDetailPage = lazy(() => import('../../features/employees/EmployeeDetailPage'))
const EmployeeFormPage = lazy(() => import('../../features/employees/EmployeeFormPage'))
const SupervisorListPage = lazy(() => import('../../features/supervisors/SupervisorListPage'))
const DocumentReviewPage = lazy(() => import('../../features/documents/DocumentReviewPage'))
const MyDocumentsPage = lazy(() => import('../../features/documents/MyDocumentsPage'))

const AttendancePage = lazy(() => import('../../features/attendance/AttendancePage'))
const MyAttendancePage = lazy(() => import('../../features/attendance/MyAttendancePage'))
const OvertimePage = lazy(() => import('../../features/attendance/OvertimePage'))
const LeavePage = lazy(() => import('../../features/leave/LeavePage'))
const MyLeavePage = lazy(() => import('../../features/leave/MyLeavePage'))
const CalendarPage = lazy(() => import('../../features/calendar/CalendarPage'))

const SalaryPage = lazy(() => import('../../features/salary/SalaryPage'))
const PayrollListPage = lazy(() => import('../../features/payroll/PayrollListPage'))
const PayrollRunPage = lazy(() => import('../../features/payroll/PayrollRunPage'))
const PayrollItemPage = lazy(() => import('../../features/payroll/PayrollItemPage'))
const PayslipDocumentsPage = lazy(() => import('../../features/payroll/PayslipDocumentsPage'))
const PaymentsPage = lazy(() => import('../../features/payments/PaymentsPage'))
const BonusesPage = lazy(() => import('../../features/bonuses/BonusesPage'))
const OtherDeductionsPage = lazy(() => import('../../features/other-deductions/OtherDeductionsPage'))
const TaxPage = lazy(() => import('../../features/tax/TaxPage'))
const LwfPage = lazy(() => import('../../features/lwf/LwfPage'))
const PlWagesPage = lazy(() => import('../../features/pl-wages/PlWagesPage'))

const MyProfilePage = lazy(() => import('../../features/employees/MyProfilePage'))
const MySalaryPage = lazy(() => import('../../features/payroll/MySalaryPage'))
const MyPayslipsPage = lazy(() => import('../../features/payroll/MyPayslipsPage'))

const ReportsPage = lazy(() => import('../../features/reports/ReportsPage'))
const OrganizationPage = lazy(() => import('../../features/organization/OrganizationPage'))
const UsersPage = lazy(() => import('../../features/users/UsersPage'))
const AuditLogPage = lazy(() => import('../../features/audit/AuditLogPage'))
const MessagingPage = lazy(() => import('../../features/messaging/MessagingPage'))
const SettingsPage = lazy(() => import('../../features/settings/SettingsPage'))

function PageFallback() {
  return (
    <div className="route-fallback">
      <Spinner label="Loading page" />
    </div>
  )
}

/** Requires a session, and optionally one of a set of permissions. */
function Protected({ anyOf, children }: { anyOf?: string[]; children: ReactNode }) {
  const { status, canAny, user } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <PageFallback />
  if (status === 'unauthenticated') return <Navigate to="/login" state={{ from: location.pathname }} replace />

  // A forced password change blocks everything else.
  if (user?.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />
  }

  if (anyOf && anyOf.length > 0 && !canAny(...anyOf)) {
    return (
      <EmptyState
        title="You do not have access to this page"
        description="If you believe this is a mistake, ask an administrator to review your permissions."
      />
    )
  }

  return <>{children}</>
}

/** Keeps a signed-in user away from the sign-in screens. */
function PublicOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  if (status === 'loading') return <PageFallback />
  if (status === 'authenticated') return <Navigate to="/" replace />
  return <>{children}</>
}

export function AppRouter() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route
          path="/login"
          element={
            <PublicOnly>
              <LoginPage />
            </PublicOnly>
          }
        />
        <Route
          path="/forgot-password"
          element={
            <PublicOnly>
              <ForgotPasswordPage />
            </PublicOnly>
          }
        />
        <Route
          path="/reset-password"
          element={
            <PublicOnly>
              <ResetPasswordPage />
            </PublicOnly>
          }
        />

        <Route
          element={
            <Protected>
              <AppLayout />
            </Protected>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="/change-password" element={<ChangePasswordPage />} />

          <Route
            path="/employees"
            element={
              <Protected anyOf={['employee.view.all', 'employee.view.team']}>
                <EmployeeListPage />
              </Protected>
            }
          />
          <Route
            path="/employees/new"
            element={
              <Protected anyOf={['employee.create']}>
                <EmployeeFormPage />
              </Protected>
            }
          />
          <Route
            path="/employees/:id"
            element={
              <Protected anyOf={['employee.view.all', 'employee.view.team', 'employee.view.self']}>
                <EmployeeDetailPage />
              </Protected>
            }
          />
          <Route
            path="/employees/:id/edit"
            element={
              <Protected anyOf={['employee.update']}>
                <EmployeeFormPage />
              </Protected>
            }
          />
          <Route
            path="/supervisors"
            element={
              <Protected anyOf={['employee.view.all']}>
                <SupervisorListPage />
              </Protected>
            }
          />
          <Route
            path="/documents"
            element={
              <Protected anyOf={['document.view.all', 'document.view.team']}>
                <DocumentReviewPage />
              </Protected>
            }
          />

          <Route
            path="/attendance"
            element={
              <Protected anyOf={['attendance.view.all', 'attendance.view.team']}>
                <AttendancePage />
              </Protected>
            }
          />
          <Route
            path="/overtime"
            element={
              <Protected anyOf={['overtime.view.all', 'overtime.view.team']}>
                <OvertimePage />
              </Protected>
            }
          />
          <Route
            path="/leave"
            element={
              <Protected anyOf={['leave.view.all', 'leave.view.team', 'leave.approve.all', 'leave.approve.team']}>
                <LeavePage />
              </Protected>
            }
          />
          <Route
            path="/calendar"
            element={
              <Protected anyOf={['holiday.view', 'weeklyoff.view']}>
                <CalendarPage />
              </Protected>
            }
          />

          <Route
            path="/salary"
            element={
              <Protected anyOf={['salary.structure.view', 'salary.view.all']}>
                <SalaryPage />
              </Protected>
            }
          />
          <Route
            path="/payroll"
            element={
              <Protected anyOf={['payroll.view.all', 'payroll.view.team']}>
                <PayrollListPage />
              </Protected>
            }
          />
          <Route
            path="/payroll/runs/:id"
            element={
              <Protected anyOf={['payroll.view.all', 'payroll.view.team']}>
                <PayrollRunPage />
              </Protected>
            }
          />
          <Route
            path="/payslips-noc"
            element={
              <Protected anyOf={['payslip.view.all']}>
                <PayslipDocumentsPage />
              </Protected>
            }
          />
          <Route
            path="/payroll/items/:id"
            element={
              <Protected anyOf={['payroll.view.all', 'payroll.view.team', 'payroll.view.self']}>
                <PayrollItemPage />
              </Protected>
            }
          />
          <Route
            path="/payments"
            element={
              <Protected anyOf={['payment.view.all']}>
                <PaymentsPage />
              </Protected>
            }
          />
          <Route
            path="/bonuses"
            element={
              <Protected anyOf={['bonus.view']}>
                <BonusesPage />
              </Protected>
            }
          />
          <Route
            path="/other-deductions"
            element={
              <Protected anyOf={['payroll.adjust', 'payroll.view.all']}>
                <OtherDeductionsPage />
              </Protected>
            }
          />
          <Route
            path="/tax"
            element={
              <Protected anyOf={['tax.view']}>
                <TaxPage />
              </Protected>
            }
          />
          <Route
            path="/lwf"
            element={
              <Protected anyOf={['lwf.view']}>
                <LwfPage />
              </Protected>
            }
          />
          <Route
            path="/pl-wages"
            element={
              <Protected anyOf={['plwages.view']}>
                <PlWagesPage />
              </Protected>
            }
          />

          <Route
            path="/my-profile"
            element={
              <Protected anyOf={['employee.view.self']}>
                <MyProfilePage />
              </Protected>
            }
          />
          <Route
            path="/my-attendance"
            element={
              <Protected anyOf={['attendance.view.self']}>
                <MyAttendancePage />
              </Protected>
            }
          />
          <Route
            path="/my-leave"
            element={
              <Protected anyOf={['leave.view.self']}>
                <MyLeavePage />
              </Protected>
            }
          />
          <Route
            path="/my-salary"
            element={
              <Protected anyOf={['salary.view.self', 'payroll.view.self']}>
                <MySalaryPage />
              </Protected>
            }
          />
          <Route
            path="/my-payslips"
            element={
              <Protected anyOf={['payslip.view.self']}>
                <MyPayslipsPage />
              </Protected>
            }
          />
          <Route
            path="/my-documents"
            element={
              <Protected anyOf={['document.view.self']}>
                <MyDocumentsPage />
              </Protected>
            }
          />

          <Route
            path="/reports"
            element={
              <Protected anyOf={['report.view.all', 'report.view.team']}>
                <ReportsPage />
              </Protected>
            }
          />
          <Route
            path="/organization"
            element={
              <Protected anyOf={['org.view']}>
                <OrganizationPage />
              </Protected>
            }
          />
          <Route
            path="/users"
            element={
              <Protected anyOf={['user.view']}>
                <UsersPage />
              </Protected>
            }
          />
          <Route
            path="/messaging"
            element={
              <Protected anyOf={['message.view']}>
                <MessagingPage />
              </Protected>
            }
          />
          <Route
            path="/audit-logs"
            element={
              <Protected anyOf={['audit.view']}>
                <AuditLogPage />
              </Protected>
            }
          />
          <Route
            path="/settings"
            element={
              <Protected anyOf={['settings.view']}>
                <SettingsPage />
              </Protected>
            }
          />

          <Route
            path="*"
            element={
              <EmptyState
                title="Page not found"
                description="The page you are looking for does not exist or has moved."
              />
            }
          />
        </Route>
      </Routes>
    </Suspense>
  )
}
