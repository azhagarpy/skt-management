import { ApiError } from '../../utils/api-error.js'
import { pool, queryOne } from '../../database/pool.js'
import { todayIso } from '../../utils/dates.js'
import { toMajor, toMinor } from '../../utils/money.js'
import { loadLetterhead, money } from '../../utils/pdf.js'
import { recordAudit, type AuditContext } from '../audit/audit.service.js'
import * as salaryRepository from '../salary/salary.repository.js'
import { toComponentInputs } from '../payroll/payroll.service.js'
import { resolveFullAmounts } from '../payroll/payroll.calculator.js'
import type { AuthContext } from '../../types/express.js'
import { renderAppointmentLetterPdf } from './appointment-pdf.js'

/**
 * Issues the statutory Letter of Appointment for one employee.
 *
 * Everything on it is read from the records rather than typed: the point of
 * generating the letter here is that what the employee is handed and what
 * payroll will actually pay them come from the same row. Only the free-text
 * "any other information" is supplied by the caller.
 */

/** The wage components counted as "Basic / Pay and Dearness Allowance" rather than as allowances. */
const WAGE_CODES = new Set(['BASIC', 'DA', 'BASIC_DA', 'DEARNESS', 'DEARNESS_ALLOWANCE'])

interface EmployeeForLetter {
  id: string
  employee_code: string
  first_name: string
  middle_name: string | null
  last_name: string | null
  gender: string
  date_of_birth: string | null
  parent_name: string | null
  employment_type: string
  skill_category: string | null
  duties: string | null
  joining_date: string
  designation_name: string | null
  aadhaar_number: string | null
  uan_number: string | null
  pf_applicable: boolean | null
  esi_number: string | null
  esi_applicable: boolean | null
}

/** One line, no control characters, capped: it is typed by a person and printed on a letter. */
export function cleanOtherInformation(value: string | undefined | null): string | null {
  if (!value) return null
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned ? cleaned.slice(0, 300) : null
}

/**
 * The employee's wage as at `onDate`, split the way the form asks for it.
 *
 * An employee with no salary assignment still gets a letter: the wage lines
 * come back empty and print as "NA", which is honest, rather than the letter
 * being refused over a field that the form itself allows to be blank.
 */
async function wageLines(
  organizationId: string,
  employeeId: string,
  onDate: string,
): Promise<{ wages: string[]; allowances: string[]; basis: 'MONTHLY' | 'DAILY' | null }> {
  const assignment = await salaryRepository.findAssignmentForDate(employeeId, onDate)
  if (!assignment) return { wages: [], allowances: [], basis: null }

  const structure = await salaryRepository.findStructure(assignment.salary_structure_id, organizationId)
  if (!structure) return { wages: [], allowances: [], basis: null }

  const basis = structure.salary_basis === 'DAILY' ? 'DAILY' : 'MONTHLY'

  const resolved = resolveFullAmounts(
    toComponentInputs(structure),
    assignment.override_amount === null ? null : toMinor(Number(assignment.override_amount)),
  )

  const wages: string[] = []
  const allowances: string[] = []
  for (const component of resolved) {
    if (component.componentType !== 'EARNING') continue
    const line = `${component.name}: INR ${money(toMajor(component.amountMinor))}`
    if (WAGE_CODES.has(component.code.toUpperCase())) wages.push(line)
    else allowances.push(line)
  }

  // A structure with no component the form would call a wage still has a wage:
  // whatever it does pay is the basic, so it is shown there rather than nowhere.
  if (wages.length === 0 && allowances.length > 0) return { wages: allowances, allowances: [], basis }
  return { wages, allowances, basis }
}

export async function generateAppointmentLetter(
  auth: AuthContext,
  employeeId: string,
  otherInformation: string | undefined,
  context: AuditContext,
) {
  const employee = await queryOne<EmployeeForLetter>(
    pool,
    `SELECT e.id, e.employee_code, e.first_name, e.middle_name, e.last_name,
            e.gender::text AS gender, e.date_of_birth::text AS date_of_birth, e.parent_name,
            e.employment_type::text AS employment_type, e.skill_category::text AS skill_category,
            e.duties, e.joining_date::text AS joining_date,
            g.name AS designation_name,
            a.aadhaar_number,
            pf.uan_number, pf.pf_applicable,
            esi.esi_number, esi.esi_applicable
       FROM employees e
       LEFT JOIN designations g ON g.id = e.designation_id
       LEFT JOIN employee_aadhaar_details a ON a.employee_id = e.id
       LEFT JOIN employee_pf_details pf ON pf.employee_id = e.id
       LEFT JOIN employee_esi_details esi ON esi.employee_id = e.id
      WHERE e.id = $1 AND e.organization_id = $2`,
    [employeeId, auth.organizationId],
  )
  if (!employee) throw ApiError.notFound('Employee')

  const organization = await queryOne<{ labour_identification_number: string | null }>(
    pool,
    'SELECT labour_identification_number FROM organizations WHERE id = $1',
    [auth.organizationId],
  )

  const issuedOn = todayIso()
  const letterhead = await loadLetterhead(auth.organizationId)
  const name = [employee.first_name, employee.middle_name, employee.last_name]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
  // The wage as it stands today, not as it stood on the joining date: the
  // letter is reissued from current records and has to match the current pay.
  const { wages, allowances, basis } = await wageLines(auth.organizationId, employee.id, issuedOn)
  const cleanedOtherInformation = cleanOtherInformation(otherInformation)

  const buffer = await renderAppointmentLetterPdf({
    letterhead,
    employeeName: name,
    employeeCode: employee.employee_code,
    dateOfBirth: employee.date_of_birth,
    parentName: employee.parent_name,
    aadhaarNumber: employee.aadhaar_number,
    labourIdentificationNumber: organization?.labour_identification_number ?? null,
    uanNumber: employee.uan_number,
    esiNumber: employee.esi_number,
    designation: employee.designation_name,
    employmentType: employee.employment_type,
    skillCategory: employee.skill_category,
    joiningDate: employee.joining_date,
    wageLines: wages,
    otherAllowanceLines: allowances,
    wageBasis: basis,
    pfApplicable: employee.pf_applicable ?? false,
    esiApplicable: employee.esi_applicable ?? false,
    duties: employee.duties,
    maternityBenefitApplicable: employee.gender === 'FEMALE',
    otherInformation: cleanedOtherInformation,
    issuedOn,
  })

  await recordAudit({
    ...context,
    action: 'APPOINTMENT_LETTER_GENERATED',
    entityType: 'employee',
    entityId: employee.id,
    newValues: { employeeCode: employee.employee_code, otherInformation: cleanedOtherInformation },
  })

  return {
    buffer,
    filename: `appointment-letter-${employee.employee_code}.pdf`,
    mimeType: 'application/pdf',
  }
}
