import { ApiError } from '../../utils/api-error.js'
import { withTransaction } from '../../database/tx.js'
import { buildBrandingStorageKey, sniffContentType } from '../../utils/files.js'
import { storage } from '../documents/storage.service.js'
import { logger } from '../../utils/logger.js'
import { recordAudit, diffValues, type AuditContext } from '../audit/audit.service.js'
import * as repository from './organization.repository.js'
import type {
  DepartmentInput,
  DesignationInput,
  ListQuery,
  LocationInput,
  SettingsUpsertInput,
  UpdateDepartmentInput,
  UpdateDesignationInput,
  UpdateLocationInput,
  UpdateOrganizationInput,
} from './organization.validation.js'

// ---------------------------------------------------------------------------
// Presenters: snake_case rows are never sent to the client as-is.
// ---------------------------------------------------------------------------

export function presentOrganization(row: repository.OrganizationRow) {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legal_name,
    code: row.code,
    email: row.email,
    phone: row.phone,
    website: row.website,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    country: row.country,
    pincode: row.pincode,
    taxId: row.tax_id,
    registrationNo: row.registration_no,
    labourIdentificationNumber: row.labour_identification_number,
    /**
     * The key itself is never sent: the logo is fetched through the
     * permission-checked endpoint, never a public URL. `logoUpdatedAt` doubles
     * as the client's cache key so a replaced logo is picked up immediately.
     */
    hasLogo: row.logo_path !== null,
    logoUpdatedAt: row.logo_updated_at ? row.logo_updated_at.toISOString() : null,
    themeColor: row.theme_color,
    currencyCode: row.currency_code,
    timezone: row.timezone,
    fiscalYearStartMonth: row.fiscal_year_start_month,
    isActive: row.is_active,
  }
}

export function presentDepartment(row: repository.DepartmentRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    parentDepartmentId: row.parent_department_id,
    headEmployeeId: row.head_employee_id,
    isActive: row.is_active,
    employeeCount: row.employee_count === undefined ? undefined : Number(row.employee_count),
  }
}

export function presentDesignation(row: repository.DesignationRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    departmentId: row.department_id,
    level: row.level,
    isActive: row.is_active,
    employeeCount: row.employee_count === undefined ? undefined : Number(row.employee_count),
  }
}

export function presentLocation(row: repository.LocationRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    country: row.country,
    pincode: row.pincode,
    timezone: row.timezone,
    isActive: row.is_active,
    employeeCount: row.employee_count === undefined ? undefined : Number(row.employee_count),
  }
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export async function getOrganization(organizationId: string) {
  const row = await repository.findOrganization(organizationId)
  if (!row) throw ApiError.notFound('Organization')
  return presentOrganization(row)
}

export async function updateOrganization(
  organizationId: string,
  input: UpdateOrganizationInput,
  context: AuditContext,
) {
  const existing = await repository.findOrganization(organizationId)
  if (!existing) throw ApiError.notFound('Organization')

  const updates = {
    name: input.name,
    legal_name: input.legalName,
    email: input.email,
    phone: input.phone,
    website: input.website,
    address_line1: input.addressLine1,
    address_line2: input.addressLine2,
    city: input.city,
    state: input.state,
    country: input.country,
    pincode: input.pincode,
    tax_id: input.taxId,
    registration_no: input.registrationNo,
    labour_identification_number: input.labourIdentificationNumber,
    currency_code: input.currencyCode,
    timezone: input.timezone,
    fiscal_year_start_month: input.fiscalYearStartMonth,
    theme_color: input.themeColor,
  }

  const updated = await repository.updateOrganization(organizationId, updates, undefined)
  if (!updated) throw ApiError.notFound('Organization')

  const diff = diffValues(existing as unknown as Record<string, unknown>, updates as Record<string, unknown>)
  await recordAudit({
    ...context,
    action: 'ORGANIZATION_UPDATED',
    entityType: 'organization',
    entityId: organizationId,
    oldValues: diff.old,
    newValues: diff.new,
  })

  return presentOrganization(updated)
}

// ---------------------------------------------------------------------------
// Branding: logo
// ---------------------------------------------------------------------------

/** Logos are rendered inline in the app chrome, so only real images are kept. */
const LOGO_TYPES = new Set(['image/png', 'image/jpeg'])

export async function readOrganizationLogo(
  organizationId: string,
): Promise<{ buffer: Buffer; mimeType: string; updatedAt: Date | null }> {
  const existing = await repository.findOrganization(organizationId)
  if (!existing) throw ApiError.notFound('Organization')
  if (!existing.logo_path) throw ApiError.notFound('Logo')

  return {
    buffer: await storage.get(existing.logo_path),
    mimeType: existing.logo_mime_type ?? 'application/octet-stream',
    updatedAt: existing.logo_updated_at,
  }
}

export async function updateOrganizationLogo(
  organizationId: string,
  file: { buffer: Buffer; originalname: string },
  context: AuditContext,
) {
  const existing = await repository.findOrganization(organizationId)
  if (!existing) throw ApiError.notFound('Organization')

  // The browser-declared type is advisory; the magic bytes decide.
  const contentType = sniffContentType(file.buffer)
  if (!contentType || !LOGO_TYPES.has(contentType)) {
    throw ApiError.badRequest('A logo must be a PNG or JPEG image')
  }

  const key = buildBrandingStorageKey(organizationId, contentType)
  await storage.put(key, file.buffer, contentType)

  const updated = await repository.updateOrganization(organizationId, {
    logo_path: key,
    logo_mime_type: contentType,
    logo_updated_at: new Date(),
  })
  if (!updated) throw ApiError.notFound('Organization')

  // Best effort: a stale object is harmless, a failed request is not.
  if (existing.logo_path && existing.logo_path !== key) {
    await storage.delete(existing.logo_path).catch((error: unknown) => {
      logger.warn({ error, key: existing.logo_path }, 'Could not delete the replaced organization logo')
    })
  }

  await recordAudit({
    ...context,
    action: 'ORGANIZATION_LOGO_UPDATED',
    entityType: 'organization',
    entityId: organizationId,
    newValues: { mimeType: contentType, bytes: file.buffer.length },
  })

  return presentOrganization(updated)
}

export async function removeOrganizationLogo(organizationId: string, context: AuditContext) {
  const existing = await repository.findOrganization(organizationId)
  if (!existing) throw ApiError.notFound('Organization')
  if (!existing.logo_path) throw ApiError.notFound('Logo')

  const updated = await repository.updateOrganization(organizationId, {
    logo_path: null,
    logo_mime_type: null,
    logo_updated_at: null,
  })
  if (!updated) throw ApiError.notFound('Organization')

  await storage.delete(existing.logo_path).catch((error: unknown) => {
    logger.warn({ error, key: existing.logo_path }, 'Could not delete the removed organization logo')
  })

  await recordAudit({
    ...context,
    action: 'ORGANIZATION_LOGO_REMOVED',
    entityType: 'organization',
    entityId: organizationId,
  })

  return presentOrganization(updated)
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export async function listDepartments(organizationId: string, filters: ListQuery) {
  const rows = await repository.listDepartments(organizationId, filters)
  return rows.map(presentDepartment)
}

export async function getDepartment(organizationId: string, id: string) {
  const row = await repository.findDepartment(id, organizationId)
  if (!row) throw ApiError.notFound('Department')
  return presentDepartment(row)
}

export async function createDepartment(organizationId: string, input: DepartmentInput, context: AuditContext) {
  if (input.parentDepartmentId) {
    const parent = await repository.findDepartment(input.parentDepartmentId, organizationId)
    if (!parent) throw ApiError.badRequest('The parent department does not exist')
  }

  const row = await repository.insertDepartment({
    organization_id: organizationId,
    name: input.name,
    code: input.code,
    description: input.description ?? null,
    parent_department_id: input.parentDepartmentId ?? null,
    head_employee_id: input.headEmployeeId ?? null,
    is_active: input.isActive ?? true,
  })

  await recordAudit({
    ...context,
    action: 'DEPARTMENT_CREATED',
    entityType: 'department',
    entityId: row.id,
    newValues: presentDepartment(row),
  })

  return presentDepartment(row)
}

export async function updateDepartment(
  organizationId: string,
  id: string,
  input: UpdateDepartmentInput,
  context: AuditContext,
) {
  const existing = await repository.findDepartment(id, organizationId)
  if (!existing) throw ApiError.notFound('Department')

  if (input.parentDepartmentId === id) {
    throw ApiError.businessRule('A department cannot be its own parent')
  }

  const updates = {
    name: input.name,
    code: input.code,
    description: input.description,
    parent_department_id: input.parentDepartmentId,
    head_employee_id: input.headEmployeeId,
    is_active: input.isActive,
  }

  const updated = await repository.updateDepartment(id, organizationId, updates)
  if (!updated) throw ApiError.notFound('Department')

  const diff = diffValues(existing as unknown as Record<string, unknown>, updates as Record<string, unknown>)
  await recordAudit({
    ...context,
    action: 'DEPARTMENT_UPDATED',
    entityType: 'department',
    entityId: id,
    oldValues: diff.old,
    newValues: diff.new,
  })

  return presentDepartment(updated)
}

export async function deleteDepartment(organizationId: string, id: string, context: AuditContext) {
  const existing = await repository.findDepartment(id, organizationId)
  if (!existing) throw ApiError.notFound('Department')

  const employeeCount = await repository.countEmployeesInDepartment(id)
  if (employeeCount > 0) {
    throw ApiError.businessRule(
      `This department still has ${employeeCount} employee(s). Move them first, or deactivate the department instead.`,
    )
  }

  await repository.deleteDepartment(id, organizationId)
  await recordAudit({
    ...context,
    action: 'DEPARTMENT_DELETED',
    entityType: 'department',
    entityId: id,
    oldValues: presentDepartment(existing),
  })
}

// ---------------------------------------------------------------------------
// Designations
// ---------------------------------------------------------------------------

export async function listDesignations(organizationId: string, filters: ListQuery) {
  const rows = await repository.listDesignations(organizationId, filters)
  return rows.map(presentDesignation)
}

export async function getDesignation(organizationId: string, id: string) {
  const row = await repository.findDesignation(id, organizationId)
  if (!row) throw ApiError.notFound('Section')
  return presentDesignation(row)
}

export async function createDesignation(organizationId: string, input: DesignationInput, context: AuditContext) {
  if (input.departmentId) {
    const department = await repository.findDepartment(input.departmentId, organizationId)
    if (!department) throw ApiError.badRequest('The selected department does not exist')
  }

  const row = await repository.insertDesignation({
    organization_id: organizationId,
    name: input.name,
    code: input.code,
    description: input.description ?? null,
    department_id: input.departmentId ?? null,
    level: input.level ?? null,
    is_active: input.isActive ?? true,
  })

  await recordAudit({
    ...context,
    action: 'DESIGNATION_CREATED',
    entityType: 'designation',
    entityId: row.id,
    newValues: presentDesignation(row),
  })

  return presentDesignation(row)
}

export async function updateDesignation(
  organizationId: string,
  id: string,
  input: UpdateDesignationInput,
  context: AuditContext,
) {
  const existing = await repository.findDesignation(id, organizationId)
  if (!existing) throw ApiError.notFound('Section')

  const updates = {
    name: input.name,
    code: input.code,
    description: input.description,
    department_id: input.departmentId,
    level: input.level,
    is_active: input.isActive,
  }

  const updated = await repository.updateDesignation(id, organizationId, updates)
  if (!updated) throw ApiError.notFound('Section')

  const diff = diffValues(existing as unknown as Record<string, unknown>, updates as Record<string, unknown>)
  await recordAudit({
    ...context,
    action: 'DESIGNATION_UPDATED',
    entityType: 'designation',
    entityId: id,
    oldValues: diff.old,
    newValues: diff.new,
  })

  return presentDesignation(updated)
}

export async function deleteDesignation(organizationId: string, id: string, context: AuditContext) {
  const existing = await repository.findDesignation(id, organizationId)
  if (!existing) throw ApiError.notFound('Section')

  const employeeCount = await repository.countEmployeesWithDesignation(id)
  if (employeeCount > 0) {
    throw ApiError.businessRule(
      `This section is assigned to ${employeeCount} employee(s). Reassign them first, or deactivate it instead.`,
    )
  }

  await repository.deleteDesignation(id, organizationId)
  await recordAudit({
    ...context,
    action: 'DESIGNATION_DELETED',
    entityType: 'designation',
    entityId: id,
    oldValues: presentDesignation(existing),
  })
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function listLocations(organizationId: string, filters: ListQuery) {
  const rows = await repository.listLocations(organizationId, filters)
  return rows.map(presentLocation)
}

export async function getLocation(organizationId: string, id: string) {
  const row = await repository.findLocation(id, organizationId)
  if (!row) throw ApiError.notFound('Location')
  return presentLocation(row)
}

export async function createLocation(organizationId: string, input: LocationInput, context: AuditContext) {
  const row = await repository.insertLocation({
    organization_id: organizationId,
    name: input.name,
    code: input.code,
    address_line1: input.addressLine1 ?? null,
    address_line2: input.addressLine2 ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    country: input.country ?? 'India',
    pincode: input.pincode ?? null,
    timezone: input.timezone ?? null,
    is_active: input.isActive ?? true,
  })

  await recordAudit({
    ...context,
    action: 'LOCATION_CREATED',
    entityType: 'location',
    entityId: row.id,
    newValues: presentLocation(row),
  })

  return presentLocation(row)
}

export async function updateLocation(
  organizationId: string,
  id: string,
  input: UpdateLocationInput,
  context: AuditContext,
) {
  const existing = await repository.findLocation(id, organizationId)
  if (!existing) throw ApiError.notFound('Location')

  const updates = {
    name: input.name,
    code: input.code,
    address_line1: input.addressLine1,
    address_line2: input.addressLine2,
    city: input.city,
    state: input.state,
    country: input.country,
    pincode: input.pincode,
    timezone: input.timezone,
    is_active: input.isActive,
  }

  const updated = await repository.updateLocation(id, organizationId, updates)
  if (!updated) throw ApiError.notFound('Location')

  const diff = diffValues(existing as unknown as Record<string, unknown>, updates as Record<string, unknown>)
  await recordAudit({
    ...context,
    action: 'LOCATION_UPDATED',
    entityType: 'location',
    entityId: id,
    oldValues: diff.old,
    newValues: diff.new,
  })

  return presentLocation(updated)
}

export async function deleteLocation(organizationId: string, id: string, context: AuditContext) {
  const existing = await repository.findLocation(id, organizationId)
  if (!existing) throw ApiError.notFound('Location')

  const employeeCount = await repository.countEmployeesAtLocation(id)
  if (employeeCount > 0) {
    throw ApiError.businessRule(
      `This location still has ${employeeCount} employee(s). Move them first, or deactivate it instead.`,
    )
  }

  await repository.deleteLocation(id, organizationId)
  await recordAudit({
    ...context,
    action: 'LOCATION_DELETED',
    entityType: 'location',
    entityId: id,
    oldValues: presentLocation(existing),
  })
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function listSettings(organizationId: string, category?: string) {
  const rows = await repository.listSettings(organizationId, category)
  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    key: row.key,
    value: row.value,
    description: row.description,
    updatedAt: row.updated_at,
  }))
}

export async function upsertSettings(
  organizationId: string,
  userId: string,
  input: SettingsUpsertInput,
  context: AuditContext,
) {
  const saved = await withTransaction(async (tx) => {
    const results = []
    for (const setting of input.settings) {
      results.push(
        await repository.upsertSetting(
          {
            organizationId,
            category: setting.category,
            key: setting.key,
            value: setting.value,
            description: setting.description ?? null,
            userId,
          },
          tx,
        ),
      )
    }
    return results
  })

  await recordAudit({
    ...context,
    action: 'SETTINGS_UPDATED',
    entityType: 'system_settings',
    entityId: null,
    newValues: input.settings.map((setting) => ({ category: setting.category, key: setting.key })),
  })

  return saved.map((row) => ({
    id: row.id,
    category: row.category,
    key: row.key,
    value: row.value,
    description: row.description,
    updatedAt: row.updated_at,
  }))
}
