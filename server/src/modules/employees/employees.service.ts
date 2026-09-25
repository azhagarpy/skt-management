import { ApiError } from '../../utils/api-error.js'
import { buildPaginated, type Paginated } from '../../utils/pagination.js'
import { toMajor, toMinor } from '../../utils/money.js'
import { withTransaction } from '../../database/tx.js'
import { pool, queryOne, type Queryable } from '../../database/pool.js'
import { recordAudit, diffValues, type AuditContext } from '../audit/audit.service.js'
import { hashPassword } from '../auth/password.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { buildStorageKey, sniffContentType } from '../../utils/files.js'
import { storage } from '../documents/storage.service.js'
import { logger } from '../../utils/logger.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './employees.repository.js'
import { assertEmployeeInScope, resolveScope, scopeClause, type EmployeeScope } from './employee-access.js'
import type {
  AddressInput,
  CreateEmployeeInput,
  EmergencyContactInput,
  EmployeeListQuery,
  JobHistoryInput,
  UpdateEmployeeInput,
  UpdateOwnProfileInput,
} from './employees.validation.js'

/** Initial password for employee logins created without an explicit one. */
const DEFAULT_EMPLOYEE_PASSWORD = 'SKT@123'

// ---------------------------------------------------------------------------
// Profile completion (plan sections 12 and 45)
// ---------------------------------------------------------------------------

export const REQUIRED_PROFILE_SECTIONS = [
  'PERSONAL_INFORMATION',
  'PAN',
  'AADHAAR',
  'BANK_DETAILS',
  'PF_DETAILS',
  'ESI_DETAILS',
] as const

export type ProfileSection = (typeof REQUIRED_PROFILE_SECTIONS)[number]

export interface ProfileCompletion {
  sections: {
    section: ProfileSection
    label: string
    complete: boolean
    verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED' | null
  }[]
  completedSections: number
  totalSections: number
  completionPercent: number
  isComplete: boolean
}

const SECTION_LABELS: Record<ProfileSection, string> = {
  PERSONAL_INFORMATION: 'Personal Information',
  PAN: 'PAN',
  AADHAAR: 'Aadhaar',
  BANK_DETAILS: 'Bank Details',
  PF_DETAILS: 'PF Details',
  ESI_DETAILS: 'ESI Details',
}

type VerificationStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | null

function asStatus(value: string | null): VerificationStatus {
  if (value === 'PENDING' || value === 'VERIFIED' || value === 'REJECTED') return value
  return null
}

export function buildCompletion(row: repository.CompletionRow): ProfileCompletion {
  const sections: ProfileCompletion['sections'] = [
    {
      section: 'PERSONAL_INFORMATION',
      label: SECTION_LABELS.PERSONAL_INFORMATION,
      complete: row.has_personal,
      verificationStatus: null,
    },
    { section: 'PAN', label: SECTION_LABELS.PAN, complete: row.has_pan, verificationStatus: asStatus(row.pan_status) },
    {
      section: 'AADHAAR',
      label: SECTION_LABELS.AADHAAR,
      complete: row.has_aadhaar,
      verificationStatus: asStatus(row.aadhaar_status),
    },
    {
      section: 'BANK_DETAILS',
      label: SECTION_LABELS.BANK_DETAILS,
      complete: row.has_bank,
      verificationStatus: asStatus(row.bank_status),
    },
    {
      section: 'PF_DETAILS',
      label: SECTION_LABELS.PF_DETAILS,
      complete: row.has_pf,
      verificationStatus: asStatus(row.pf_status),
    },
    {
      section: 'ESI_DETAILS',
      label: SECTION_LABELS.ESI_DETAILS,
      complete: row.has_esi,
      verificationStatus: asStatus(row.esi_status),
    },
  ]

  const completedSections = sections.filter((section) => section.complete).length
  const totalSections = sections.length
  return {
    sections,
    completedSections,
    totalSections,
    completionPercent: Math.round((completedSections / totalSections) * 100),
    isComplete: completedSections === totalSections,
  }
}

export async function getProfileCompletion(employeeId: string, db: Queryable = pool): Promise<ProfileCompletion> {
  const row = await repository.findCompletion(employeeId, db)
  if (!row) throw ApiError.notFound('Employee')
  return buildCompletion(row)
}

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

export function fullName(row: { first_name: string; middle_name?: string | null; last_name: string | null }): string {
  return [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

export function presentEmployeeSummary(row: repository.EmployeeListRow) {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    firstName: row.first_name,
    middleName: row.middle_name,
    lastName: row.last_name,
    fullName: fullName(row),
    workEmail: row.work_email,
    personalEmail: row.personal_email,
    mobileNumber: row.mobile_number,
    departmentId: row.department_id,
    departmentName: row.department_name,
    designationId: row.designation_id,
    designationName: row.designation_name,
    locationId: row.location_id,
    locationName: row.location_name,
    supervisorId: row.supervisor_id,
    supervisorName: row.supervisor_name,
    isSupervisor: row.is_supervisor,
    employmentType: row.employment_type,
    employmentStatus: row.employment_status,
    salaryBasis: row.salary_basis,
    employeeTypeId: row.employee_type_id,
    employeeTypeName: row.employee_type_name,
    employeeTypeCode: row.employee_type_code,
    plant: row.plant,
    overtimeRateOverride: row.overtime_rate_override_minor === null ? null : toMajor(row.overtime_rate_override_minor),
    joiningDate: row.joining_date,
    exitDate: row.exit_date,
    userId: row.user_id,
    userEmail: row.user_email,
    userRole: row.user_role,
    userStatus: row.user_status,
  }
}

export function presentEmployeeDetail(
  row: repository.EmployeeListRow,
  extras: {
    addresses: repository.AddressRow[]
    emergencyContacts: repository.EmergencyContactRow[]
    completion: ProfileCompletion
  },
) {
  return {
    ...presentEmployeeSummary(row),
    gender: row.gender,
    dateOfBirth: row.date_of_birth,
    maritalStatus: row.marital_status,
    bloodGroup: row.blood_group,
    parentName: row.parent_name,
    skillCategory: row.skill_category,
    duties: row.duties,
    alternateNumber: row.alternate_number,
    confirmationDate: row.confirmation_date,
    noticeStartDate: row.notice_start_date,
    exitReason: row.exit_reason,
    /** The storage key is never sent; the photo is fetched through the permission-checked endpoint. */
    hasPhoto: row.photo_path !== null,
    photoUpdatedAt: row.photo_updated_at ? row.photo_updated_at.toISOString() : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    addresses: extras.addresses.map((address) => ({
      id: address.id,
      addressType: address.address_type,
      addressLine1: address.address_line1,
      addressLine2: address.address_line2,
      city: address.city,
      state: address.state,
      country: address.country,
      pincode: address.pincode,
    })),
    emergencyContacts: extras.emergencyContacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      relationship: contact.relationship,
      phone: contact.phone,
      alternatePhone: contact.alternate_phone,
      address: contact.address,
      isPrimary: contact.is_primary,
    })),
    profileCompletion: extras.completion,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listEmployees(
  auth: AuthContext,
  filters: EmployeeListQuery,
): Promise<Paginated<ReturnType<typeof presentEmployeeSummary> & { profileCompletionPercent?: number }>> {
  const scope = resolveScope(auth, {
    all: PERMISSIONS.EMPLOYEE_VIEW_ALL,
    team: PERMISSIONS.EMPLOYEE_VIEW_TEAM,
    self: PERMISSIONS.EMPLOYEE_VIEW_SELF,
  })

  const clause = scopeClause(auth, scope, 'e', 1)
  const { rows, total } = await repository.listEmployees(clause, filters)

  const completions = await repository.listCompletion(rows.map((row) => row.id))
  const completionByEmployee = new Map(completions.map((row) => [row.employee_id, buildCompletion(row)]))

  const items = rows.map((row) => ({
    ...presentEmployeeSummary(row),
    profileCompletionPercent: completionByEmployee.get(row.id)?.completionPercent,
  }))

  return buildPaginated(items, total, filters.page, filters.pageSize)
}

export async function getEmployee(auth: AuthContext, employeeId: string) {
  const scope = resolveScope(auth, {
    all: PERMISSIONS.EMPLOYEE_VIEW_ALL,
    team: PERMISSIONS.EMPLOYEE_VIEW_TEAM,
    self: PERMISSIONS.EMPLOYEE_VIEW_SELF,
  })
  await assertEmployeeInScope(auth, employeeId, scope)

  const row = await repository.findEmployeeById(employeeId, auth.organizationId)
  if (!row) throw ApiError.notFound('Employee')

  const [addresses, emergencyContacts, completion] = await Promise.all([
    repository.listAddresses(employeeId),
    repository.listEmergencyContacts(employeeId),
    getProfileCompletion(employeeId),
  ])

  return presentEmployeeDetail(row, { addresses, emergencyContacts, completion })
}

export async function getJobHistory(auth: AuthContext, employeeId: string) {
  const scope = resolveScope(auth, {
    all: PERMISSIONS.EMPLOYEE_VIEW_ALL,
    team: PERMISSIONS.EMPLOYEE_VIEW_TEAM,
    self: PERMISSIONS.EMPLOYEE_VIEW_SELF,
  })
  await assertEmployeeInScope(auth, employeeId, scope)

  const rows = await repository.listJobHistory(employeeId)
  return rows.map((row) => ({
    id: row.id,
    changeType: row.change_type,
    effectiveFrom: row.effective_from,
    departmentId: row.department_id,
    departmentName: row.department_name,
    designationId: row.designation_id,
    designationName: row.designation_name,
    locationId: row.location_id,
    supervisorId: row.supervisor_id,
    supervisorName: row.supervisor_name,
    employmentType: row.employment_type,
    employmentStatus: row.employment_status,
    notes: row.notes,
    createdAt: row.created_at,
  }))
}

// ---------------------------------------------------------------------------
// Photo
// ---------------------------------------------------------------------------

/** Photos are rendered inline on profiles/payslips, so only real images are kept. */
const PHOTO_TYPES = new Set(['image/png', 'image/jpeg'])

export async function readEmployeePhoto(
  auth: AuthContext,
  employeeId: string,
): Promise<{ buffer: Buffer; mimeType: string; updatedAt: Date | null }> {
  const scope = resolveScope(auth, {
    all: PERMISSIONS.EMPLOYEE_VIEW_ALL,
    team: PERMISSIONS.EMPLOYEE_VIEW_TEAM,
    self: PERMISSIONS.EMPLOYEE_VIEW_SELF,
  })
  await assertEmployeeInScope(auth, employeeId, scope)

  const existing = await repository.findEmployeeById(employeeId, auth.organizationId)
  if (!existing) throw ApiError.notFound('Employee')
  if (!existing.photo_path) throw ApiError.notFound('Photo')

  return {
    buffer: await storage.get(existing.photo_path),
    mimeType: existing.photo_mime_type ?? 'application/octet-stream',
    updatedAt: existing.photo_updated_at,
  }
}

export async function uploadEmployeePhoto(
  auth: AuthContext,
  employeeId: string,
  file: { buffer: Buffer; originalname: string },
  context: AuditContext,
) {
  const existing = await repository.findEmployeeById(employeeId, auth.organizationId)
  if (!existing) throw ApiError.notFound('Employee')

  // The browser-declared type is advisory; the magic bytes decide.
  const contentType = sniffContentType(file.buffer)
  if (!contentType || !PHOTO_TYPES.has(contentType)) {
    throw ApiError.badRequest('A photo must be a PNG or JPEG image')
  }

  const key = buildStorageKey({ organizationId: auth.organizationId, employeeId, category: 'photo', contentType })
  await storage.put(key, file.buffer, contentType)

  const updated = await repository.updateEmployee(employeeId, auth.organizationId, {
    photo_path: key,
    photo_mime_type: contentType,
    photo_updated_at: new Date(),
    updated_by: auth.userId,
  })
  if (!updated) throw ApiError.notFound('Employee')

  // Best effort: a stale object is harmless, a failed request is not.
  if (existing.photo_path && existing.photo_path !== key) {
    await storage.delete(existing.photo_path).catch((error: unknown) => {
      logger.warn({ error, key: existing.photo_path }, 'Could not delete the replaced employee photo')
    })
  }

  await recordAudit({
    ...context,
    action: 'EMPLOYEE_PHOTO_UPDATED',
    entityType: 'employee',
    entityId: employeeId,
    newValues: { mimeType: contentType, bytes: file.buffer.length },
  })

  return {
    id: updated.id,
    hasPhoto: true,
    photoUpdatedAt: updated.photo_updated_at ? updated.photo_updated_at.toISOString() : null,
  }
}

export async function removeEmployeePhoto(auth: AuthContext, employeeId: string, context: AuditContext) {
  const existing = await repository.findEmployeeById(employeeId, auth.organizationId)
  if (!existing) throw ApiError.notFound('Employee')
  if (!existing.photo_path) throw ApiError.notFound('Photo')

  await repository.updateEmployee(employeeId, auth.organizationId, {
    photo_path: null,
    photo_mime_type: null,
    photo_updated_at: null,
    updated_by: auth.userId,
  })

  await storage.delete(existing.photo_path).catch((error: unknown) => {
    logger.warn({ error, key: existing.photo_path }, 'Could not delete the removed employee photo')
  })

  await recordAudit({
    ...context,
    action: 'EMPLOYEE_PHOTO_REMOVED',
    entityType: 'employee',
    entityId: employeeId,
  })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function assertReferencesExist(
  organizationId: string,
  input: { departmentId?: string | null; designationId?: string | null; locationId?: string | null; supervisorId?: string | null },
  db: Queryable,
): Promise<void> {
  const checks: { table: string; id: string | null | undefined; label: string }[] = [
    { table: 'departments', id: input.departmentId, label: 'Department' },
    { table: 'designations', id: input.designationId, label: 'Section' },
    { table: 'locations', id: input.locationId, label: 'Location' },
  ]

  for (const check of checks) {
    if (!check.id) continue
    const row = await queryOne<{ id: string }>(
      db,
      `SELECT id FROM ${check.table} WHERE id = $1 AND organization_id = $2`,
      [check.id, organizationId],
    )
    if (!row) throw ApiError.badRequest(`${check.label} does not exist in this organization`)
  }

  if (input.supervisorId) {
    const supervisor = await queryOne<{ id: string; is_supervisor: boolean }>(
      db,
      'SELECT id, is_supervisor FROM employees WHERE id = $1 AND organization_id = $2',
      [input.supervisorId, organizationId],
    )
    if (!supervisor) throw ApiError.badRequest('The selected supervisor does not exist')
    if (!supervisor.is_supervisor) throw ApiError.businessRule('The selected employee is not marked as a supervisor')
  }
}

export async function createEmployee(auth: AuthContext, input: CreateEmployeeInput, context: AuditContext) {
  return withTransaction(async (tx) => {
    await assertReferencesExist(auth.organizationId, input, tx)

    const duplicate = await repository.findEmployeeByCode(input.employeeCode, auth.organizationId, tx)
    if (duplicate) throw ApiError.conflict('An employee with this code already exists')

    let userId: string | null = null
    if (input.createUserAccount) {
      const email = input.userEmail ?? input.workEmail ?? input.personalEmail
      if (!email) throw ApiError.badRequest('An email address is required to create a login')

      const existingUser = await queryOne<{ id: string }>(tx, 'SELECT id FROM users WHERE lower(email) = lower($1)', [
        email,
      ])
      if (existingUser) throw ApiError.conflict('An account with this email already exists')

      // A temporary password may be supplied; otherwise every employee login
      // starts with the shared default and must_change_password forces a change.
      const temporary = input.temporaryPassword ?? DEFAULT_EMPLOYEE_PASSWORD
      const created = await queryOne<{ id: string }>(
        tx,
        `INSERT INTO users (organization_id, email, password_hash, role, full_name, phone, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)
         RETURNING id`,
        [
          auth.organizationId,
          email,
          await hashPassword(temporary),
          input.userRole,
          [input.firstName, input.lastName].filter(Boolean).join(' '),
          input.mobileNumber ?? null,
        ],
      )
      userId = created?.id ?? null
    }

    const employee = await repository.insertEmployee(
      {
        organization_id: auth.organizationId,
        user_id: userId,
        employee_code: input.employeeCode,
        first_name: input.firstName,
        middle_name: input.middleName ?? null,
        last_name: input.lastName ?? null,
        gender: input.gender,
        date_of_birth: input.dateOfBirth ?? null,
        marital_status: input.maritalStatus,
        blood_group: input.bloodGroup ?? null,
        parent_name: input.parentName ?? null,
        personal_email: input.personalEmail ?? null,
        work_email: input.workEmail ?? null,
        mobile_number: input.mobileNumber ?? null,
        alternate_number: input.alternateNumber ?? null,
        department_id: input.departmentId ?? null,
        designation_id: input.designationId ?? null,
        location_id: input.locationId ?? null,
        supervisor_id: input.supervisorId ?? null,
        is_supervisor: input.isSupervisor,
        employment_type: input.employmentType,
        employment_status: input.employmentStatus,
        salary_basis: input.salaryBasis,
        employee_type_id: input.employeeTypeId,
        plant: input.plant ?? null,
        skill_category: input.skillCategory ?? null,
        duties: input.duties ?? null,
        overtime_rate_override_minor: input.overtimeRateOverride == null ? null : toMinor(input.overtimeRateOverride),
        joining_date: input.joiningDate,
        confirmation_date: input.confirmationDate ?? null,
        created_by: auth.userId,
      },
      tx,
    )

    if (input.address) {
      await repository.upsertAddress(
        employee.id,
        {
          address_type: input.address.addressType,
          address_line1: input.address.addressLine1,
          address_line2: input.address.addressLine2 ?? null,
          city: input.address.city,
          state: input.address.state,
          country: input.address.country,
          pincode: input.address.pincode,
        },
        tx,
      )
    }

    if (input.emergencyContact) {
      await repository.replacePrimaryEmergencyContact(
        employee.id,
        {
          name: input.emergencyContact.name,
          relationship: input.emergencyContact.relationship,
          phone: input.emergencyContact.phone,
          alternate_phone: input.emergencyContact.alternatePhone ?? null,
          address: input.emergencyContact.address ?? null,
        },
        tx,
      )
    }

    // The joining row anchors the employment history.
    await repository.insertJobHistory(
      {
        organization_id: auth.organizationId,
        employee_id: employee.id,
        change_type: 'JOINED',
        effective_from: input.joiningDate,
        department_id: input.departmentId ?? null,
        designation_id: input.designationId ?? null,
        location_id: input.locationId ?? null,
        supervisor_id: input.supervisorId ?? null,
        employment_type: input.employmentType,
        employment_status: input.employmentStatus,
        employee_type_id: input.employeeTypeId,
        plant: input.plant ?? null,
        notes: 'Employee onboarded',
        created_by: auth.userId,
      },
      tx,
    )

    await recordAudit(
      {
        ...context,
        action: 'EMPLOYEE_CREATED',
        entityType: 'employee',
        entityId: employee.id,
        newValues: { employeeCode: employee.employee_code, name: fullName(employee), userCreated: Boolean(userId) },
      },
      tx,
    )

    const detail = await repository.findEmployeeById(employee.id, auth.organizationId, tx)
    return detail ? presentEmployeeSummary(detail) : presentEmployeeSummary(employee as repository.EmployeeListRow)
  })
}

/** Change types worth recording in job history when the corresponding field moves. */
const HISTORY_TRIGGERS: { field: keyof UpdateEmployeeInput; changeType: string }[] = [
  { field: 'departmentId', changeType: 'DEPARTMENT_CHANGE' },
  { field: 'designationId', changeType: 'DESIGNATION_CHANGE' },
  { field: 'locationId', changeType: 'LOCATION_CHANGE' },
  { field: 'supervisorId', changeType: 'SUPERVISOR_CHANGE' },
  { field: 'employmentType', changeType: 'EMPLOYMENT_TYPE_CHANGE' },
  { field: 'employmentStatus', changeType: 'STATUS_CHANGE' },
  { field: 'employeeTypeId', changeType: 'EMPLOYEE_TYPE_CHANGE' },
  { field: 'plant', changeType: 'PLANT_CHANGE' },
]

export async function updateEmployee(
  auth: AuthContext,
  employeeId: string,
  input: UpdateEmployeeInput,
  context: AuditContext,
) {
  return withTransaction(async (tx) => {
    const existing = await repository.findEmployeeById(employeeId, auth.organizationId, tx)
    if (!existing) throw ApiError.notFound('Employee')

    if (input.supervisorId && input.supervisorId === employeeId) {
      throw ApiError.businessRule('An employee cannot be their own supervisor')
    }
    await assertReferencesExist(auth.organizationId, input, tx)

    if (input.exitDate && input.joiningDate && input.exitDate < input.joiningDate) {
      throw ApiError.businessRule('Exit date cannot be before the joining date')
    }
    if (input.exitDate && input.exitDate < existing.joining_date && !input.joiningDate) {
      throw ApiError.businessRule('Exit date cannot be before the joining date')
    }

    const updates = {
      first_name: input.firstName,
      middle_name: input.middleName,
      last_name: input.lastName,
      gender: input.gender,
      date_of_birth: input.dateOfBirth,
      marital_status: input.maritalStatus,
      blood_group: input.bloodGroup,
      parent_name: input.parentName,
      personal_email: input.personalEmail,
      work_email: input.workEmail,
      mobile_number: input.mobileNumber,
      alternate_number: input.alternateNumber,
      department_id: input.departmentId,
      designation_id: input.designationId,
      location_id: input.locationId,
      supervisor_id: input.supervisorId,
      is_supervisor: input.isSupervisor,
      employment_type: input.employmentType,
      employment_status: input.employmentStatus,
      salary_basis: input.salaryBasis,
      employee_type_id: input.employeeTypeId,
      plant: input.plant,
      skill_category: input.skillCategory,
      duties: input.duties,
      overtime_rate_override_minor: input.overtimeRateOverride === undefined ? undefined : (input.overtimeRateOverride === null ? null : toMinor(input.overtimeRateOverride)),
      joining_date: input.joiningDate,
      confirmation_date: input.confirmationDate,
      notice_start_date: input.noticeStartDate,
      exit_date: input.exitDate,
      exit_reason: input.exitReason,
      updated_by: auth.userId,
    }

    const updated = await repository.updateEmployee(employeeId, auth.organizationId, updates, tx)
    if (!updated) throw ApiError.notFound('Employee')

    // Record one history row per structural change, so the trail explains itself.
    for (const trigger of HISTORY_TRIGGERS) {
      const nextValue = input[trigger.field]
      if (nextValue === undefined) continue
      const columnMap: Record<string, keyof repository.EmployeeRow> = {
        departmentId: 'department_id',
        designationId: 'designation_id',
        locationId: 'location_id',
        supervisorId: 'supervisor_id',
        employmentType: 'employment_type',
        employmentStatus: 'employment_status',
        employeeTypeId: 'employee_type_id',
        plant: 'plant',
      }
      const column = columnMap[trigger.field as string]
      if (!column) continue
      if (existing[column] === nextValue) continue

      await repository.insertJobHistory(
        {
          organization_id: auth.organizationId,
          employee_id: employeeId,
          change_type: trigger.changeType,
          effective_from: input.exitDate ?? new Date().toISOString().slice(0, 10),
          department_id: updated.department_id,
          designation_id: updated.designation_id,
          location_id: updated.location_id,
          supervisor_id: updated.supervisor_id,
          employment_type: updated.employment_type,
          employment_status: updated.employment_status,
          employee_type_id: updated.employee_type_id,
          plant: updated.plant,
          notes: input.changeReason ?? null,
          created_by: auth.userId,
        },
        tx,
      )
    }

    const diff = diffValues(existing as unknown as Record<string, unknown>, updates as Record<string, unknown>)
    await recordAudit(
      {
        ...context,
        action: input.employmentStatus && input.employmentStatus !== existing.employment_status
          ? 'EMPLOYEE_STATUS_CHANGED'
          : 'EMPLOYEE_UPDATED',
        entityType: 'employee',
        entityId: employeeId,
        oldValues: diff.old,
        newValues: diff.new,
      },
      tx,
    )

    const detail = await repository.findEmployeeById(employeeId, auth.organizationId, tx)
    return detail ? presentEmployeeSummary(detail) : presentEmployeeSummary(updated as repository.EmployeeListRow)
  })
}

/** The self-service update path: a strictly narrower field set. */
export async function updateOwnProfile(
  auth: AuthContext,
  employeeId: string,
  input: UpdateOwnProfileInput,
  context: AuditContext,
) {
  return withTransaction(async (tx) => {
    const existing = await repository.findEmployeeById(employeeId, auth.organizationId, tx)
    if (!existing) throw ApiError.notFound('Employee')

    const updates = {
      personal_email: input.personalEmail,
      mobile_number: input.mobileNumber,
      alternate_number: input.alternateNumber,
      marital_status: input.maritalStatus,
      blood_group: input.bloodGroup,
      updated_by: auth.userId,
    }

    await repository.updateEmployee(employeeId, auth.organizationId, updates, tx)

    if (input.address) {
      await repository.upsertAddress(
        employeeId,
        {
          address_type: input.address.addressType,
          address_line1: input.address.addressLine1,
          address_line2: input.address.addressLine2 ?? null,
          city: input.address.city,
          state: input.address.state,
          country: input.address.country,
          pincode: input.address.pincode,
        },
        tx,
      )
    }

    if (input.emergencyContact) {
      await repository.replacePrimaryEmergencyContact(
        employeeId,
        {
          name: input.emergencyContact.name,
          relationship: input.emergencyContact.relationship,
          phone: input.emergencyContact.phone,
          alternate_phone: input.emergencyContact.alternatePhone ?? null,
          address: input.emergencyContact.address ?? null,
        },
        tx,
      )
    }

    const diff = diffValues(existing as unknown as Record<string, unknown>, updates as Record<string, unknown>)
    await recordAudit(
      {
        ...context,
        action: 'EMPLOYEE_UPDATED',
        entityType: 'employee',
        entityId: employeeId,
        oldValues: diff.old,
        newValues: { ...diff.new, selfService: true },
      },
      tx,
    )

    const [row, addresses, emergencyContacts, completion] = await Promise.all([
      repository.findEmployeeById(employeeId, auth.organizationId, tx),
      repository.listAddresses(employeeId, tx),
      repository.listEmergencyContacts(employeeId, tx),
      getProfileCompletion(employeeId, tx),
    ])
    if (!row) throw ApiError.notFound('Employee')
    return presentEmployeeDetail(row, { addresses, emergencyContacts, completion })
  })
}

export async function deleteEmployee(auth: AuthContext, employeeId: string, context: AuditContext) {
  const existing = await repository.findEmployeeById(employeeId, auth.organizationId)
  if (!existing) throw ApiError.notFound('Employee')

  // Financial history must keep its subject; deactivation is the correct action.
  if (await repository.hasFinancialHistory(employeeId)) {
    throw ApiError.businessRule(
      'This employee has payroll or salary history and cannot be deleted. Set their status to INACTIVE instead.',
    )
  }

  const supervises = await repository.listTeamEmployeeIds(employeeId)
  if (supervises.length > 0) {
    throw ApiError.businessRule(
      `This employee supervises ${supervises.length} other employee(s). Reassign them before deleting.`,
    )
  }

  await repository.deleteEmployee(employeeId, auth.organizationId)
  await recordAudit({
    ...context,
    action: 'EMPLOYEE_DELETED',
    entityType: 'employee',
    entityId: employeeId,
    oldValues: { employeeCode: existing.employee_code, name: fullName(existing) },
  })
}

export async function upsertAddress(
  auth: AuthContext,
  employeeId: string,
  input: AddressInput,
  context: AuditContext,
) {
  const row = await repository.upsertAddress(employeeId, {
    address_type: input.addressType,
    address_line1: input.addressLine1,
    address_line2: input.addressLine2 ?? null,
    city: input.city,
    state: input.state,
    country: input.country,
    pincode: input.pincode,
  })

  await recordAudit({
    ...context,
    action: 'EMPLOYEE_UPDATED',
    entityType: 'employee_address',
    entityId: row.id,
    newValues: { employeeId, addressType: input.addressType },
  })

  return row
}

export async function upsertEmergencyContact(
  auth: AuthContext,
  employeeId: string,
  input: EmergencyContactInput,
  context: AuditContext,
) {
  const row = await repository.replacePrimaryEmergencyContact(employeeId, {
    name: input.name,
    relationship: input.relationship,
    phone: input.phone,
    alternate_phone: input.alternatePhone ?? null,
    address: input.address ?? null,
  })

  await recordAudit({
    ...context,
    action: 'EMPLOYEE_UPDATED',
    entityType: 'employee_emergency_contact',
    entityId: row.id,
    newValues: { employeeId },
  })

  return row
}

export async function addJobHistory(
  auth: AuthContext,
  employeeId: string,
  input: JobHistoryInput,
  context: AuditContext,
) {
  await assertEmployeeInScope(auth, employeeId, 'ALL')
  await repository.insertJobHistory({
    organization_id: auth.organizationId,
    employee_id: employeeId,
    change_type: input.changeType,
    effective_from: input.effectiveFrom,
    department_id: input.departmentId ?? null,
    designation_id: input.designationId ?? null,
    location_id: input.locationId ?? null,
    supervisor_id: input.supervisorId ?? null,
    employment_type: input.employmentType ?? null,
    employment_status: input.employmentStatus ?? null,
    notes: input.notes ?? null,
    created_by: auth.userId,
  })

  await recordAudit({
    ...context,
    action: 'EMPLOYEE_UPDATED',
    entityType: 'employee_job_history',
    entityId: employeeId,
    newValues: { changeType: input.changeType, effectiveFrom: input.effectiveFrom },
  })

  return getJobHistory(auth, employeeId)
}

/** Lightweight list used by selectors on the client. */
export async function listSupervisors(auth: AuthContext) {
  const scope: EmployeeScope = auth.has(PERMISSIONS.EMPLOYEE_VIEW_ALL) ? 'ALL' : 'TEAM'
  const clause = scopeClause(auth, scope, 'e', 1)
  const { rows } = await repository.listEmployees(clause, {
    page: 1,
    pageSize: 200,
    sortOrder: 'asc',
    isSupervisor: true,
    employmentStatus: 'ACTIVE',
  } as EmployeeListQuery)
  return rows.map(presentEmployeeSummary)
}
