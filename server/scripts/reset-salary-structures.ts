/**
 * One-off data fix: replace the old placeholder salary structures with the
 * four minimum-wage-board categories (US/SS/SK/HS) effective 01.04.2026, and
 * reassign the current employees to them. Run once with `tsx scripts/reset-salary-structures.ts`.
 */
import 'dotenv/config'
import { pool } from '../src/database/pool.js'
import * as salaryService from '../src/modules/salary/salary.service.js'
import type { AuthContext } from '../src/types/express.js'
import type { PermissionCode } from '../src/modules/auth/permissions.js'

const ORG_ID = '05a0fa24-f487-4e76-9a98-8e1e5aed65ec'
const ADMIN_USER_ID = '4df025aa-6a93-4957-b56e-333a88150352' // admin@skt.com

const auth: AuthContext = {
  userId: ADMIN_USER_ID,
  organizationId: ORG_ID,
  role: 'SUPER_ADMIN',
  email: 'admin@skt.com',
  fullName: 'Script',
  employeeId: null,
  permissions: new Set<PermissionCode>(),
  has: () => true,
  hasAny: () => true,
}

const context = { organizationId: ORG_ID, userId: ADMIN_USER_ID }

const NEW_STRUCTURES = [
  { code: 'US', name: 'Un-Skilled', basic: 350, da: 206 },
  { code: 'SS', name: 'Semi Skilled', basic: 410, da: 240 },
  { code: 'SK', name: 'Skilled', basic: 494, da: 287 },
  { code: 'HS', name: 'Highly Skilled', basic: 579, da: 339 },
] as const

const ASSIGNMENTS: { employeeId: string; structureCode: (typeof NEW_STRUCTURES)[number]['code'] }[] = [
  { employeeId: '2a86205e-2049-49d6-89a0-c4ab5a2f0aa5', structureCode: 'SS' }, // SENT0001 Senthil Natarajan
  { employeeId: '449dd5a4-cae5-497b-b9af-31187d4cd2f6', structureCode: 'SS' }, // SENT0004 Selvam Selvam
  { employeeId: '3b675e13-07a6-4b6f-836e-06983e28e983', structureCode: 'US' }, // SKT Senthil SK
]

const EFFECTIVE_FROM = '2026-09-20'

async function main() {
  const components = (
    await pool.query<{ id: string; code: string }>(
      'SELECT id, code FROM salary_components WHERE organization_id = $1 AND code IN ($2, $3)',
      [ORG_ID, 'BASIC', 'DA'],
    )
  ).rows
  const basicComponentId = components.find((c) => c.code === 'BASIC')?.id
  const daComponentId = components.find((c) => c.code === 'DA')?.id
  if (!basicComponentId || !daComponentId) throw new Error('Basic/DA salary components not found')

  // --- Remove the old structures. Assignment rows referencing them must go
  // first (RESTRICT); payroll_items keeps its own snapshot and only loses the
  // now-dangling FK (ON DELETE SET NULL), so past payroll figures are untouched.
  const oldStructures = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM salary_structures WHERE organization_id = $1',
    [ORG_ID],
  )
  for (const old of oldStructures.rows) {
    await pool.query('DELETE FROM employee_salary_assignments WHERE salary_structure_id = $1', [old.id])
    await pool.query('DELETE FROM salary_structures WHERE id = $1', [old.id])
    console.log(`Deleted old structure: ${old.name}`)
  }

  // --- Create the four new structures as DAILY basis (the board's rates are
  // per day; the calculator multiplies by paid days for a DAILY structure).
  const structureIdByCode = new Map<string, string>()
  for (const def of NEW_STRUCTURES) {
    const created = await salaryService.createStructure(
      auth,
      {
        name: def.name,
        code: def.code,
        description: `Minimum wages w.e.f. 01.04.2026`,
        salaryBasis: 'DAILY',
        currencyCode: 'INR',
        isActive: true,
        pfEmployeeRate: 12,
        pfEmployerRate: 12,
        esiEmployeeRate: 0.75,
        esiEmployerRate: 3.25,
        components: [
          { salaryComponentId: basicComponentId, calculationType: 'FIXED', amount: def.basic, percentage: 0, displayOrder: 0 },
          { salaryComponentId: daComponentId, calculationType: 'FIXED', amount: def.da, percentage: 0, displayOrder: 1 },
        ],
      },
      context,
    )
    if (!created) throw new Error(`Failed to create structure ${def.code}`)
    structureIdByCode.set(def.code, created.id)
    console.log(`Created structure ${def.code} (${def.name}): Basic ${def.basic} + DA ${def.da} = ${def.basic + def.da}/day`)
  }

  // --- Switch the affected employees to DAILY salary basis so the new rates
  // (a per-day amount) are multiplied by paid days rather than paid as-is.
  const employeeIds = ASSIGNMENTS.map((a) => a.employeeId)
  await pool.query(
    `UPDATE employees SET salary_basis = 'DAILY' WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
    [employeeIds, ORG_ID],
  )
  console.log(`Switched ${employeeIds.length} employee(s) to DAILY salary basis`)

  // --- Assign each employee to their new structure.
  for (const assignment of ASSIGNMENTS) {
    const structureId = structureIdByCode.get(assignment.structureCode)
    if (!structureId) throw new Error(`Unknown structure code ${assignment.structureCode}`)
    await salaryService.assignSalary(
      auth,
      assignment.employeeId,
      { salaryStructureId: structureId, effectiveFrom: EFFECTIVE_FROM as never, effectiveTo: null, overrideAmount: null, notes: 'Minimum wage board update w.e.f. 01.04.2026' },
      context,
    )
    console.log(`Assigned employee ${assignment.employeeId} to ${assignment.structureCode}`)
  }

  console.log('Done.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
