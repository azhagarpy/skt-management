import { Router } from 'express'
import { sendSuccess } from './utils/http.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { departmentRouter, designationRouter, locationRouter, organizationRouter } from './modules/organization/organization.routes.js'
import { employeeRouter } from './modules/employees/employees.routes.js'
import { notificationRouter } from './modules/notifications/notifications.routes.js'
import { calendarRouter, holidayRouter, shiftRouter, weeklyOffRouter } from './modules/calendar/calendar.routes.js'
import { attendanceRouter } from './modules/attendance/attendance.routes.js'
import { overtimeRouter } from './modules/overtime/overtime.routes.js'
import { leaveRouter } from './modules/leave/leave.routes.js'
import { employeeSalaryRouter, salaryRouter } from './modules/salary/salary.routes.js'
import { bonusRouter } from './modules/bonuses/bonuses.module.js'
import { taxRouter } from './modules/tax/tax.module.js'
import { lwfRouter } from './modules/lwf/lwf.module.js'
import { plWagesRouter } from './modules/pl-wages/pl-wages.module.js'
import { paymentRouter, payrollRouter } from './modules/payroll/payroll.routes.js'
import { payslipRouter } from './modules/payslips/payslips.routes.js'
import { nocRouter } from './modules/noc/noc.routes.js'
import { appointmentRouter } from './modules/appointment/appointment.routes.js'
import { reportRouter } from './modules/reports/reports.routes.js'
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js'
import { userRouter } from './modules/users/users.module.js'
import { auditRouter } from './modules/audit/audit.routes.js'
import { messagingRouter } from './modules/messaging/messaging.routes.js'

/**
 * Versioned API surface (plan section 48). Every router below the auth one
 * applies `authenticate` itself, so nothing is protected by ordering alone.
 */
export const apiRouter = Router()

apiRouter.get('/health', (_req, res) => {
  sendSuccess(res, { status: 'ok' })
})

apiRouter.use('/auth', authRouter)
apiRouter.use('/organization', organizationRouter)
apiRouter.use('/departments', departmentRouter)
apiRouter.use('/designations', designationRouter)
apiRouter.use('/locations', locationRouter)
apiRouter.use('/employees', employeeRouter)
apiRouter.use('/notifications', notificationRouter)
apiRouter.use('/holidays', holidayRouter)
apiRouter.use('/weekly-offs', weeklyOffRouter)
apiRouter.use('/shifts', shiftRouter)
apiRouter.use('/calendar', calendarRouter)
apiRouter.use('/attendance', attendanceRouter)
apiRouter.use('/overtime', overtimeRouter)
apiRouter.use('/leave', leaveRouter)
apiRouter.use('/salary', salaryRouter)
apiRouter.use('/bonuses', bonusRouter)
apiRouter.use('/tax', taxRouter)
apiRouter.use('/lwf', lwfRouter)
apiRouter.use('/pl-wages', plWagesRouter)
apiRouter.use('/payroll', payrollRouter)
apiRouter.use('/payments', paymentRouter)
apiRouter.use('/payslips', payslipRouter)
apiRouter.use('/noc', nocRouter)
apiRouter.use('/appointment-letter', appointmentRouter)
apiRouter.use('/reports', reportRouter)
apiRouter.use('/dashboard', dashboardRouter)
apiRouter.use('/users', userRouter)
apiRouter.use('/messaging', messagingRouter)
apiRouter.use('/audit-logs', auditRouter)
