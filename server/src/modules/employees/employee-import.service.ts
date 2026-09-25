/**
 * Bulk employee upload: preview, then commit.
 *
 * Preview is the whole point. It reports every problem in the file at once -
 * duplicate IDs, unknown departments, unreadable dates - so the sheet can be
 * fixed in one pass rather than one row per attempt. Nothing is written until
 * the commit, and a commit refuses outright if any row is still bad, so an
 * upload is all-or-nothing and never leaves half an intake in the system.
 */
import { pool, queryRows, type Queryable } from '../../database/pool.js'
import { withTransaction } from '../../database/tx.js'
import { ApiError } from '../../utils/api-error.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import type { AuthContext } from '../../types/express.js'
import * as repository from './employees.repository.js'
import {
  parseEmployeeSheet,
  parseSheetDate,
  validateParsedRows,
  type ParsedEmployeeRow,
  type RowProblem,
} from './employee-import.parser.js'

const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY', 'INTERN']
const EMPLOYMENT_STATUSES = ['ACTIVE', 'INACTIVE', 'ON_NOTICE', 'RESIGNED', 'TERMINATED']
const SALARY_BASES = ['MONTHLY', 'DAILY']

/** "Full Time", "full-time" and "FULL_TIME" all mean the same thing in a sheet. */
function normaliseEnum(value: string | null, allowed: string[]): string | null {
  if (value === null) return null
  const candidate = value.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return allowed.includes(candidate) ? candidate : null
}

interface Lookup {
  departments: Map<string, string>
  designations: Map<string, string>
  employeeTypes: Map<string, string>
  defaultEmployeeTypeId: string | null
  existingCodes: Set<string>
}

async function loadLookup(organizationId: string, db: Queryable): Promise<Lookup> {
  const key = (value: string) => value.trim().toLowerCase()

  const [departments, designations, employeeTypes, employees] = await Promise.all([
    queryRows<{ id: string; name: string; code: string }>(
      db, 'SELECT id, name, code FROM departments WHERE organization_id = $1 AND is_active', [organizationId]),
    queryRows<{ id: string; name: string; code: string }>(
      db, 'SELECT id, name, code FROM designations WHERE organization_id = $1 AND is_active', [organizationId]),
    queryRows<{ id: string; name: string; code: string; display_order: number }>(
      db, 'SELECT id, name, code, display_order FROM employee_types WHERE organization_id = $1 AND is_active ORDER BY display_order', [organizationId]),
    queryRows<{ employee_code: string }>(
      db, 'SELECT employee_code FROM employees WHERE organization_id = $1', [organizationId]),
  ])

  // Name or code both resolve, since an export writes the name but people
  // often type the code.
  const index = (rows: { id: string; name: string; code: string }[]) => {
    const map = new Map<string, string>()
    for (const row of rows) {
      map.set(key(row.name), row.id)
      map.set(key(row.code), row.id)
    }
    return map
  }

  return {
    departments: index(departments),
    designations: index(designations),
    employeeTypes: index(employeeTypes),
    defaultEmployeeTypeId: employeeTypes[0]?.id ?? null,
    existingCodes: new Set(employees.map((row) => row.employee_code.trim().toUpperCase())),
  }
}

export interface ResolvedRow {
  rowNumber: number
  employeeCode: string
  name: string
  values: Record<string, unknown>
}

export interface ImportPreview {
  totalRows: number
  readyCount: number
  problems: RowProblem[]
  ignoredColumns: string[]
  /** What the first few rows will be created as, for a glance before committing. */
  sample: { employeeCode: string; name: string; departmentName: string | null; employeeTypeName: string | null }[]
}

/** Splits a name into the parts the employees table stores. */
function splitName(full: string): { first: string; last: string | null } {
  const parts = full.trim().split(/\s+/)
  if (parts.length === 1) return { first: parts[0] ?? full.trim(), last: null }
  // Tamil names here carry initials on either side, so anything beyond the
  // first word is kept together rather than guessed at.
  return { first: parts[0] as string, last: parts.slice(1).join(' ') }
}

function resolveRows(
  rows: ParsedEmployeeRow[],
  lookup: Lookup,
  organizationId: string,
  userId: string | null,
): { resolved: ResolvedRow[]; problems: RowProblem[] } {
  const problems: RowProblem[] = [...validateParsedRows(rows)]
  const badRows = new Set(problems.map((problem) => problem.rowNumber))
  const resolved: ResolvedRow[] = []

  for (const row of rows) {
    const code = row.employeeCode.trim()
    const upper = code.toUpperCase()

    if (lookup.existingCodes.has(upper)) {
      problems.push({
        rowNumber: row.rowNumber,
        employeeCode: code,
        message: `Employee ID ${code} already belongs to an employee in the system`,
      })
      badRows.add(row.rowNumber)
    }

    const departmentId = row.departmentName ? lookup.departments.get(row.departmentName.trim().toLowerCase()) : undefined
    if (row.departmentName && departmentId === undefined) {
      problems.push({
        rowNumber: row.rowNumber,
        employeeCode: code,
        message: `Department "${row.departmentName}" does not exist. Create it first, or clear the column.`,
      })
      badRows.add(row.rowNumber)
    }

    const designationId = row.designationName ? lookup.designations.get(row.designationName.trim().toLowerCase()) : undefined
    if (row.designationName && designationId === undefined) {
      problems.push({
        rowNumber: row.rowNumber,
        employeeCode: code,
        message: `Section "${row.designationName}" does not exist. Create it first, or clear the column.`,
      })
      badRows.add(row.rowNumber)
    }

    let employeeTypeId = row.employeeTypeName
      ? lookup.employeeTypes.get(row.employeeTypeName.trim().toLowerCase())
      : lookup.defaultEmployeeTypeId ?? undefined
    if (row.employeeTypeName && employeeTypeId === undefined) {
      problems.push({
        rowNumber: row.rowNumber,
        employeeCode: code,
        message: `Supply type "${row.employeeTypeName}" does not exist. Add it under Organization first.`,
      })
      badRows.add(row.rowNumber)
    }
    if (employeeTypeId === undefined && lookup.defaultEmployeeTypeId === null) {
      problems.push({
        rowNumber: row.rowNumber,
        employeeCode: code,
        message: 'No supply type is configured. Add one under Organization before importing.',
      })
      badRows.add(row.rowNumber)
      employeeTypeId = undefined
    }

    if (badRows.has(row.rowNumber)) continue

    const { first, last } = splitName(row.name)
    resolved.push({
      rowNumber: row.rowNumber,
      employeeCode: code,
      name: row.name.trim(),
      values: {
        organization_id: organizationId,
        employee_code: code,
        first_name: first,
        last_name: last,
        department_id: departmentId ?? null,
        designation_id: designationId ?? null,
        employee_type_id: employeeTypeId,
        employment_type: normaliseEnum(row.employmentType, EMPLOYMENT_TYPES) ?? 'FULL_TIME',
        employment_status: normaliseEnum(row.employmentStatus, EMPLOYMENT_STATUSES) ?? 'ACTIVE',
        salary_basis: normaliseEnum(row.salaryBasis, SALARY_BASES) ?? 'MONTHLY',
        joining_date: parseSheetDate(row.joiningDate),
        confirmation_date: null,
        work_email: row.workEmail,
        mobile_number: row.mobileNumber,
        created_by: userId,
      },
    })
  }

  problems.sort((a, b) => a.rowNumber - b.rowNumber)
  return { resolved, problems }
}

async function read(auth: AuthContext, file: Express.Multer.File | undefined, db: Queryable) {
  if (!file) throw ApiError.badRequest('Attach the .xlsx file under the "file" field')
  const sheet = await parseEmployeeSheet(file.buffer)
  const lookup = await loadLookup(auth.organizationId, db)
  const { resolved, problems } = resolveRows(sheet.rows, lookup, auth.organizationId, auth.userId)
  return { sheet, resolved, problems }
}

export async function previewImport(
  auth: AuthContext,
  file: Express.Multer.File | undefined,
): Promise<ImportPreview> {
  const { sheet, resolved, problems } = await read(auth, file, pool)
  return {
    totalRows: sheet.rows.length,
    readyCount: resolved.length,
    problems,
    ignoredColumns: sheet.ignoredColumns,
    sample: sheet.rows.slice(0, 5).map((row) => ({
      employeeCode: row.employeeCode,
      name: row.name,
      departmentName: row.departmentName,
      employeeTypeName: row.employeeTypeName,
    })),
  }
}

export async function commitImport(
  auth: AuthContext,
  file: Express.Multer.File | undefined,
  context: AuditContext,
): Promise<{ created: number }> {
  return withTransaction(async (tx) => {
    const { resolved, problems } = await read(auth, file, tx)

    // All or nothing: a partial intake is harder to unpick than a rejected file.
    if (problems.length > 0) {
      throw ApiError.businessRule(
        `The file still has ${problems.length} problem(s). Nothing was imported - fix the sheet and upload it again.`,
      )
    }
    if (resolved.length === 0) throw ApiError.badRequest('There are no rows to import')

    for (const row of resolved) {
      await repository.insertEmployee(row.values, tx)
    }

    await recordAudit(
      {
        ...context,
        action: 'EMPLOYEE_BULK_IMPORTED',
        entityType: 'employee',
        entityId: null,
        newValues: { created: resolved.length, codes: resolved.map((row) => row.employeeCode) },
      },
      tx,
    )

    return { created: resolved.length }
  })
}
