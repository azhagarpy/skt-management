import type { Request, Response } from 'express'
import { asyncHandler } from '../../utils/async-handler.js'
import { ApiError } from '../../utils/api-error.js'
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/http.js'
import { requireAuth } from '../../middleware/authenticate.js'
import { auditContextFrom } from '../audit/audit.service.js'
import * as service from './organization.service.js'
import type {
  DepartmentInput,
  DesignationInput,
  EmployeeTypeInput,
  ListQuery,
  LocationInput,
  SettingsUpsertInput,
  UpdateDepartmentInput,
  UpdateDesignationInput,
  UpdateEmployeeTypeInput,
  UpdateLocationInput,
  UpdateOrganizationInput,
} from './organization.validation.js'

export const getOrganization = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await service.getOrganization(auth.organizationId))
})

export const updateOrganization = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.updateOrganization(
    auth.organizationId,
    req.body as UpdateOrganizationInput,
    auditContextFrom(req),
  )
  return sendSuccess(res, data, 'Organization updated successfully')
})

/**
 * Streams the organization logo. Like employee documents it is never exposed
 * through a public URL - the client fetches it with its bearer token and turns
 * it into an object URL. `nosniff` plus an explicit image type means a crafted
 * upload cannot be re-interpreted by the browser.
 */
export const getOrganizationLogo = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const logo = await service.readOrganizationLogo(auth.organizationId)

  res.setHeader('Content-Type', logo.mimeType)
  res.setHeader('Content-Length', String(logo.buffer.length))
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Disposition', 'inline')
  if (logo.updatedAt) res.setHeader('Last-Modified', logo.updatedAt.toUTCString())
  res.send(logo.buffer)
})

export const updateOrganizationLogo = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  if (!req.file) throw ApiError.badRequest('Attach a PNG or JPEG logo under the "file" field')

  const data = await service.updateOrganizationLogo(auth.organizationId, req.file, auditContextFrom(req))
  return sendSuccess(res, data, 'Logo updated successfully')
})

export const removeOrganizationLogo = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.removeOrganizationLogo(auth.organizationId, auditContextFrom(req))
  return sendSuccess(res, data, 'Logo removed successfully')
})

export const listDepartments = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await service.listDepartments(auth.organizationId, req.query as unknown as ListQuery))
})

export const getDepartment = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await service.getDepartment(auth.organizationId, req.params.id as string))
})

export const createDepartment = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.createDepartment(auth.organizationId, req.body as DepartmentInput, auditContextFrom(req))
  return sendCreated(res, data, 'Department created successfully')
})

export const updateDepartment = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.updateDepartment(
    auth.organizationId,
    req.params.id as string,
    req.body as UpdateDepartmentInput,
    auditContextFrom(req),
  )
  return sendSuccess(res, data, 'Department updated successfully')
})

export const deleteDepartment = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  await service.deleteDepartment(auth.organizationId, req.params.id as string, auditContextFrom(req))
  return sendNoContent(res, 'Department deleted successfully')
})

export const listEmployeeTypes = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await service.listEmployeeTypes(auth.organizationId, req.query as unknown as ListQuery))
})

export const getEmployeeType = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await service.getEmployeeType(auth.organizationId, req.params.id as string))
})

export const createEmployeeType = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.createEmployeeType(
    auth.organizationId,
    req.body as EmployeeTypeInput,
    auditContextFrom(req),
  )
  return sendCreated(res, data, 'Supply type created successfully')
})

export const updateEmployeeType = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.updateEmployeeType(
    auth.organizationId,
    req.params.id as string,
    req.body as UpdateEmployeeTypeInput,
    auditContextFrom(req),
  )
  return sendSuccess(res, data, 'Supply type updated successfully')
})

export const deleteEmployeeType = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  await service.deleteEmployeeType(auth.organizationId, req.params.id as string, auditContextFrom(req))
  return sendNoContent(res, 'Supply type deleted successfully')
})

export const listDesignations = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await service.listDesignations(auth.organizationId, req.query as unknown as ListQuery))
})

export const getDesignation = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await service.getDesignation(auth.organizationId, req.params.id as string))
})

export const createDesignation = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.createDesignation(auth.organizationId, req.body as DesignationInput, auditContextFrom(req))
  return sendCreated(res, data, 'Section created successfully')
})

export const updateDesignation = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.updateDesignation(
    auth.organizationId,
    req.params.id as string,
    req.body as UpdateDesignationInput,
    auditContextFrom(req),
  )
  return sendSuccess(res, data, 'Section updated successfully')
})

export const deleteDesignation = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  await service.deleteDesignation(auth.organizationId, req.params.id as string, auditContextFrom(req))
  return sendNoContent(res, 'Section deleted successfully')
})

export const listLocations = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await service.listLocations(auth.organizationId, req.query as unknown as ListQuery))
})

export const getLocation = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  return sendSuccess(res, await service.getLocation(auth.organizationId, req.params.id as string))
})

export const createLocation = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.createLocation(auth.organizationId, req.body as LocationInput, auditContextFrom(req))
  return sendCreated(res, data, 'Location created successfully')
})

export const updateLocation = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.updateLocation(
    auth.organizationId,
    req.params.id as string,
    req.body as UpdateLocationInput,
    auditContextFrom(req),
  )
  return sendSuccess(res, data, 'Location updated successfully')
})

export const deleteLocation = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  await service.deleteLocation(auth.organizationId, req.params.id as string, auditContextFrom(req))
  return sendNoContent(res, 'Location deleted successfully')
})

export const listSettings = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const category = (req.query as { category?: string }).category
  return sendSuccess(res, await service.listSettings(auth.organizationId, category))
})

export const upsertSettings = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const data = await service.upsertSettings(
    auth.organizationId,
    auth.userId,
    req.body as SettingsUpsertInput,
    auditContextFrom(req),
  )
  return sendSuccess(res, data, 'Settings saved successfully')
})
