import type { Request, Response } from 'express'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/http.js'
import { requireAuth } from '../../middleware/authenticate.js'
import { ApiError } from '../../utils/api-error.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import * as service from './employees.service.js'
import * as importService from './employee-import.service.js'
import { assertEmployeeInScope, requireOwnEmployeeId, resolveScope } from './employee-access.js'
import type {
  AddressInput,
  CreateEmployeeInput,
  EmergencyContactInput,
  EmployeeListQuery,
  JobHistoryInput,
  UpdateEmployeeInput,
  UpdateOwnProfileInput,
} from './employees.validation.js'
import type { AuthContext } from '../../types/express.js'

/** Resolves `:id`, mapping the literal `me` to the caller's own employee record. */
function targetEmployeeId(auth: AuthContext, param: string | undefined): string {
  if (!param || param === 'me') return requireOwnEmployeeId(auth)
  return param
}

export const listEmployees = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const result = await service.listEmployees(auth, req.query as unknown as EmployeeListQuery)
  return sendSuccess(res, result.items, undefined, 200, {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    totalPages: result.totalPages,
  })
})

export const listSupervisors = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await service.listSupervisors(auth))
})

export const getEmployee = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  return sendSuccess(res, await service.getEmployee(auth, employeeId))
})

export const getProfileCompletion = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const scope = resolveScope(auth, {
    all: PERMISSIONS.EMPLOYEE_VIEW_ALL,
    team: PERMISSIONS.EMPLOYEE_VIEW_TEAM,
    self: PERMISSIONS.EMPLOYEE_VIEW_SELF,
  })
  await assertEmployeeInScope(auth, employeeId, scope)
  return sendSuccess(res, await service.getProfileCompletion(employeeId))
})

export const getJobHistory = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  return sendSuccess(res, await service.getJobHistory(auth, employeeId))
})

export const createEmployee = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.createEmployee(auth, req.body as CreateEmployeeInput, auditContextFrom(req))
  return sendCreated(res, data, 'Employee created successfully')
})

export const updateEmployee = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  await assertEmployeeInScope(auth, employeeId, 'ALL')
  const data = await service.updateEmployee(auth, employeeId, req.body as UpdateEmployeeInput, auditContextFrom(req))
  return sendSuccess(res, data, 'Employee updated successfully')
})

export const updateOwnProfile = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = requireOwnEmployeeId(auth)
  const data = await service.updateOwnProfile(auth, employeeId, req.body as UpdateOwnProfileInput, auditContextFrom(req))
  return sendSuccess(res, data, 'Profile updated successfully')
})

export const deleteEmployee = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = req.params.id
  if (!employeeId || employeeId === 'me') throw ApiError.badRequest('An employee id is required')
  await assertEmployeeInScope(auth, employeeId, 'ALL')
  await service.deleteEmployee(auth, employeeId, auditContextFrom(req))
  return sendNoContent(res, 'Employee deleted successfully')
})

export const upsertAddress = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const scope = auth.has(PERMISSIONS.EMPLOYEE_UPDATE) ? 'ALL' : 'SELF'
  await assertEmployeeInScope(auth, employeeId, scope)
  const data = await service.upsertAddress(auth, employeeId, req.body as AddressInput, auditContextFrom(req))
  return sendSuccess(res, data, 'Address saved successfully')
})

export const upsertEmergencyContact = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const scope = auth.has(PERMISSIONS.EMPLOYEE_UPDATE) ? 'ALL' : 'SELF'
  await assertEmployeeInScope(auth, employeeId, scope)
  const data = await service.upsertEmergencyContact(
    auth,
    employeeId,
    req.body as EmergencyContactInput,
    auditContextFrom(req),
  )
  return sendSuccess(res, data, 'Emergency contact saved successfully')
})

/**
 * Streams the employee photo. Like the organization logo it is never exposed
 * through a public URL - the client fetches it with its bearer token.
 */
export const getEmployeePhoto = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const photo = await service.readEmployeePhoto(auth, employeeId)

  res.setHeader('Content-Type', photo.mimeType)
  res.setHeader('Content-Length', String(photo.buffer.length))
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Disposition', 'inline')
  if (photo.updatedAt) res.setHeader('Last-Modified', photo.updatedAt.toUTCString())
  res.send(photo.buffer)
})

export const uploadEmployeePhoto = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const scope = auth.has(PERMISSIONS.EMPLOYEE_UPDATE) ? 'ALL' : 'SELF'
  await assertEmployeeInScope(auth, employeeId, scope)
  if (!req.file) throw ApiError.badRequest('Attach a PNG or JPEG photo under the "file" field')

  const data = await service.uploadEmployeePhoto(auth, employeeId, req.file, auditContextFrom(req))
  return sendSuccess(res, data, 'Photo updated successfully')
})

export const removeEmployeePhoto = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const scope = auth.has(PERMISSIONS.EMPLOYEE_UPDATE) ? 'ALL' : 'SELF'
  await assertEmployeeInScope(auth, employeeId, scope)
  await service.removeEmployeePhoto(auth, employeeId, auditContextFrom(req))
  return sendNoContent(res, 'Photo removed successfully')
})

export const addJobHistory = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = req.params.id
  if (!employeeId || employeeId === 'me') throw ApiError.badRequest('An employee id is required')
  const data = await service.addJobHistory(auth, employeeId, req.body as JobHistoryInput, auditContextFrom(req))
  return sendCreated(res, data, 'Job history entry added')
})

// ---------------------------------------------------------------------------
// Bulk import and code suggestion
// ---------------------------------------------------------------------------

export const suggestEmployeeCode = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await service.suggestNextEmployeeCode(auth.organizationId))
})

export const previewEmployeeImport = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await importService.previewImport(auth, req.file))
})

export const commitEmployeeImport = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const result = await importService.commitImport(auth, req.file, auditContextFrom(req))
  return sendSuccess(res, result, `${result.created} employee(s) imported`)
})
