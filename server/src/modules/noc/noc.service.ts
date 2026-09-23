import { ApiError } from '../../utils/api-error.js'
import { pool, queryOne } from '../../database/pool.js'
import { todayIso } from '../../utils/dates.js'
import { loadLetterhead } from '../../utils/pdf.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import type { AuthContext } from '../../types/express.js'
import { renderNocPdf } from './noc-pdf.js'

/** Everything printed on the certificate comes from the employee's record. */
interface EmployeeForNoc {
  id: string
  employee_code: string
  first_name: string
  middle_name: string | null
  last_name: string | null
  joining_date: string
  exit_date: string | null
  employment_status: string
  department_name: string | null
  designation_name: string | null
}

/** One line, no control characters, capped: the purpose is typed by a person and printed in a sentence. */
export function cleanPurpose(value: string | undefined | null): string | null {
  if (!value) return null
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')
  return cleaned ? cleaned.slice(0, 200) : null
}

/**
 * Generates a No Objection Certificate for one employee. Restricted by the
 * route to people who can see every payslip (the administrator), and the
 * employee must belong to the caller's organization.
 */
export async function generateNoc(
  auth: AuthContext,
  employeeId: string,
  purpose: string | undefined,
  context: AuditContext,
) {
  const employee = await queryOne<EmployeeForNoc>(
    pool,
    `SELECT e.id, e.employee_code, e.first_name, e.middle_name, e.last_name,
            e.joining_date::text AS joining_date, e.exit_date::text AS exit_date,
            e.employment_status::text AS employment_status,
            d.name AS department_name, g.name AS designation_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations g ON g.id = e.designation_id
      WHERE e.id = $1 AND e.organization_id = $2`,
    [employeeId, auth.organizationId],
  )
  if (!employee) throw ApiError.notFound('Employee')

  const cleanedPurpose = cleanPurpose(purpose)
  const letterhead = await loadLetterhead(auth.organizationId)
  const name = [employee.first_name, employee.middle_name, employee.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ')

  const buffer = await renderNocPdf({
    letterhead,
    employeeName: name,
    employeeCode: employee.employee_code,
    designation: employee.designation_name,
    department: employee.department_name,
    joiningDate: employee.joining_date,
    exitDate: employee.exit_date,
    isCurrent: employee.employment_status === 'ACTIVE' || employee.employment_status === 'ON_NOTICE',
    purpose: cleanedPurpose,
    issuedOn: todayIso(),
  })

  await recordAudit({
    ...context,
    action: 'NOC_GENERATED',
    entityType: 'employee',
    entityId: employee.id,
    newValues: { employeeCode: employee.employee_code, purpose: cleanedPurpose },
  })

  return { buffer, filename: `noc-${employee.employee_code}.pdf`, mimeType: 'application/pdf' }
}
