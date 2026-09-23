import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requireAnyPermission, requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { employeeIdParam } from '../employees/employees.validation.js'
import * as service from './salary.service.js'
import {
  assignSalarySchema,
  salaryComponentSchema,
  salaryStructureSchema,
  type AssignSalaryInput,
  type SalaryComponentInput,
  type SalaryStructureInput,
} from './salary.validation.js'

const idParam = z.object({ id: z.string().uuid() })
const activeOnlyQuery = z.object({ activeOnly: z.enum(['true', 'false']).optional() })

export const salaryRouter = Router()
salaryRouter.use(authenticate)

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

salaryRouter.get(
  '/components',
  requirePermissions(PERMISSIONS.SALARY_STRUCTURE_VIEW),
  validate({ query: activeOnlyQuery }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const activeOnly = (req.query as { activeOnly?: string }).activeOnly !== 'false'
    return sendSuccess(res, await service.listComponents(auth, activeOnly))
  }),
)

salaryRouter.post(
  '/components',
  requirePermissions(PERMISSIONS.SALARY_STRUCTURE_MANAGE),
  validate({ body: salaryComponentSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.createComponent(auth, req.body as SalaryComponentInput, auditContextFrom(req))
    return sendCreated(res, data, 'Salary component created successfully')
  }),
)

salaryRouter.put(
  '/components/:id',
  requirePermissions(PERMISSIONS.SALARY_STRUCTURE_MANAGE),
  validate({ params: idParam, body: salaryComponentSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.updateComponent(
      auth,
      req.params.id as string,
      req.body as SalaryComponentInput,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Salary component updated successfully')
  }),
)

salaryRouter.delete(
  '/components/:id',
  requirePermissions(PERMISSIONS.SALARY_STRUCTURE_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    await service.deleteComponent(auth, req.params.id as string, auditContextFrom(req))
    return sendNoContent(res, 'Salary component deleted')
  }),
)

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

salaryRouter.get(
  '/structures',
  requirePermissions(PERMISSIONS.SALARY_STRUCTURE_VIEW),
  validate({ query: activeOnlyQuery }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const activeOnly = (req.query as { activeOnly?: string }).activeOnly !== 'false'
    return sendSuccess(res, await service.listStructures(auth, activeOnly))
  }),
)

salaryRouter.post(
  '/structures',
  requirePermissions(PERMISSIONS.SALARY_STRUCTURE_MANAGE),
  validate({ body: salaryStructureSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.createStructure(auth, req.body as SalaryStructureInput, auditContextFrom(req))
    return sendCreated(res, data, 'Salary structure created successfully')
  }),
)

salaryRouter.get(
  '/structures/:id',
  requirePermissions(PERMISSIONS.SALARY_STRUCTURE_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    return sendSuccess(res, await service.getStructure(auth, req.params.id as string))
  }),
)

salaryRouter.put(
  '/structures/:id',
  requirePermissions(PERMISSIONS.SALARY_STRUCTURE_MANAGE),
  validate({ params: idParam, body: salaryStructureSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const data = await service.updateStructure(
      auth,
      req.params.id as string,
      req.body as SalaryStructureInput,
      auditContextFrom(req),
    )
    return sendSuccess(res, data, 'Salary structure updated successfully')
  }),
)

/**
 * Employee-scoped salary routes, mounted under `/employees/:id/salary`.
 */
export const employeeSalaryRouter = Router({ mergeParams: true })
employeeSalaryRouter.use(authenticate)

employeeSalaryRouter.get(
  '/salary',
  requireAnyPermission(PERMISSIONS.SALARY_VIEW_ALL, PERMISSIONS.SALARY_VIEW_TEAM, PERMISSIONS.SALARY_VIEW_SELF),
  validate({ params: employeeIdParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const param = req.params.id
    const employeeId = !param || param === 'me' ? auth.employeeId : param
    if (!employeeId) throw ApiError.businessRule('Your user account is not linked to an employee record')
    return sendSuccess(res, await service.getSalaryHistory(auth, employeeId))
  }),
)

employeeSalaryRouter.post(
  '/salary',
  requirePermissions(PERMISSIONS.SALARY_MANAGE),
  validate({ params: employeeIdParam, body: assignSalarySchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const employeeId = req.params.id
    if (!employeeId || employeeId === 'me') throw ApiError.badRequest('An employee id is required')
    const data = await service.assignSalary(auth, employeeId, req.body as AssignSalaryInput, auditContextFrom(req))
    return sendCreated(res, data, 'Salary assigned successfully')
  }),
)
