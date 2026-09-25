import { Router } from 'express'
import { authenticate } from '../../middleware/authenticate.js'
import { requireAnyPermission, requirePermissions } from '../../middleware/authorize.js'
import { uploadAttendanceSheet, uploadSingleImage } from '../../middleware/upload.js'
import { validate } from '../../middleware/validate.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { documentRouter } from '../documents/documents.routes.js'
import { employeeSalaryRouter } from '../salary/salary.routes.js'
import * as controller from './employees.controller.js'
import {
  addressUpsertSchema,
  createEmployeeSchema,
  emergencyContactUpsertSchema,
  employeeIdParam,
  employeeListQuerySchema,
  jobHistorySchema,
  updateEmployeeSchema,
  updateOwnProfileSchema,
} from './employees.validation.js'

export const employeeRouter = Router()
employeeRouter.use(authenticate)

/**
 * `EMPLOYEE_VIEW_SELF` is enough to reach the list endpoint, but the service
 * narrows the query to the caller's own row - an employee calling
 * `GET /employees` receives only themselves (plan section 38).
 */
const canViewEmployees = requireAnyPermission(
  PERMISSIONS.EMPLOYEE_VIEW_ALL,
  PERMISSIONS.EMPLOYEE_VIEW_TEAM,
  PERMISSIONS.EMPLOYEE_VIEW_SELF,
)

employeeRouter.get('/', canViewEmployees, validate({ query: employeeListQuerySchema }), controller.listEmployees)

/**
 * Bulk upload, in the Employee Master export layout.
 *
 * Preview first: it reports every bad row at once so the sheet can be fixed in
 * one pass. The commit refuses unless the file is clean, so an import is all
 * or nothing.
 */
employeeRouter.get('/next-code', requirePermissions(PERMISSIONS.EMPLOYEE_CREATE), controller.suggestEmployeeCode)
employeeRouter.post(
  '/import/preview',
  requirePermissions(PERMISSIONS.EMPLOYEE_CREATE),
  uploadAttendanceSheet,
  controller.previewEmployeeImport,
)
employeeRouter.post(
  '/import',
  requirePermissions(PERMISSIONS.EMPLOYEE_CREATE),
  uploadAttendanceSheet,
  controller.commitEmployeeImport,
)
employeeRouter.get('/supervisors', canViewEmployees, controller.listSupervisors)

employeeRouter.post(
  '/',
  requirePermissions(PERMISSIONS.EMPLOYEE_CREATE),
  validate({ body: createEmployeeSchema }),
  controller.createEmployee,
)

// Self-service routes are declared before `/:id` so `me` is never treated as a uuid.
employeeRouter.get('/me/profile-completion', canViewEmployees, controller.getProfileCompletion)
employeeRouter.patch(
  '/me',
  requirePermissions(PERMISSIONS.EMPLOYEE_UPDATE_SELF),
  validate({ body: updateOwnProfileSchema }),
  controller.updateOwnProfile,
)
employeeRouter.get('/me', canViewEmployees, controller.getEmployee)

employeeRouter.get('/:id', canViewEmployees, validate({ params: employeeIdParam }), controller.getEmployee)
employeeRouter.get(
  '/:id/profile-completion',
  canViewEmployees,
  validate({ params: employeeIdParam }),
  controller.getProfileCompletion,
)
employeeRouter.get(
  '/:id/job-history',
  canViewEmployees,
  validate({ params: employeeIdParam }),
  controller.getJobHistory,
)
employeeRouter.post(
  '/:id/job-history',
  requirePermissions(PERMISSIONS.EMPLOYEE_UPDATE),
  validate({ params: employeeIdParam, body: jobHistorySchema }),
  controller.addJobHistory,
)
employeeRouter.patch(
  '/:id',
  requirePermissions(PERMISSIONS.EMPLOYEE_UPDATE),
  validate({ params: employeeIdParam, body: updateEmployeeSchema }),
  controller.updateEmployee,
)
employeeRouter.delete(
  '/:id',
  requirePermissions(PERMISSIONS.EMPLOYEE_DELETE),
  validate({ params: employeeIdParam }),
  controller.deleteEmployee,
)

employeeRouter.put(
  '/:id/address',
  requireAnyPermission(PERMISSIONS.EMPLOYEE_UPDATE, PERMISSIONS.EMPLOYEE_UPDATE_SELF),
  validate({ params: employeeIdParam, body: addressUpsertSchema }),
  controller.upsertAddress,
)
employeeRouter.put(
  '/:id/emergency-contact',
  requireAnyPermission(PERMISSIONS.EMPLOYEE_UPDATE, PERMISSIONS.EMPLOYEE_UPDATE_SELF),
  validate({ params: employeeIdParam, body: emergencyContactUpsertSchema }),
  controller.upsertEmergencyContact,
)

employeeRouter.get('/:id/photo', canViewEmployees, validate({ params: employeeIdParam }), controller.getEmployeePhoto)
employeeRouter.post(
  '/:id/photo',
  requireAnyPermission(PERMISSIONS.EMPLOYEE_UPDATE, PERMISSIONS.EMPLOYEE_UPDATE_SELF),
  validate({ params: employeeIdParam }),
  uploadSingleImage,
  controller.uploadEmployeePhoto,
)
employeeRouter.delete(
  '/:id/photo',
  requireAnyPermission(PERMISSIONS.EMPLOYEE_UPDATE, PERMISSIONS.EMPLOYEE_UPDATE_SELF),
  validate({ params: employeeIdParam }),
  controller.removeEmployeePhoto,
)

// Document, identity and financial sub-routes hang off each employee.
employeeRouter.use('/:id', documentRouter)
employeeRouter.use('/:id', employeeSalaryRouter)
