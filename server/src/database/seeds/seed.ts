import { fileURLToPath } from 'node:url'
import { env, isProduction } from '../../config/env.js'
import { logger } from '../../utils/logger.js'
import { pool, queryOne, type Queryable } from '../pool.js'
import { withTransaction } from '../tx.js'
import { migrateUp } from '../migrate.js'
import { hashPassword } from '../../modules/auth/password.service.js'
import { syncPermissionCatalogue } from '../../modules/auth/auth.service.js'
import { seedDefaultSlabs } from '../../modules/tax/tax-report.js'

/**
 * Seed: an empty workspace and the accounts that set it up.
 *
 * Creates one organization and two Super Admin logins, and nothing else. There
 * are no sample employees, departments, salary structures or payroll runs -
 * everything is configured through the application, in the order the setup
 * flow expects.
 *
 * A Super Admin is an administrative account, not a person on the payroll
 * (plan sections 3 and 47), so neither account gets an employee record.
 *
 * Refuses to run against a production database.
 */

const DEFAULT_PASSWORD = env.SEED_DEFAULT_PASSWORD

const ADMINS = [
  { email: 'admin@skt.com', fullName: 'Admin' },
  { email: 'admin1@skt.com', fullName: 'Admin One' },
]

async function seedOrganization(tx: Queryable): Promise<string> {
  const row = await queryOne<{ id: string }>(
    tx,
    `INSERT INTO organizations (name, code, country, currency_code, timezone)
     VALUES ('SKTRANSPORT', 'SKT', 'India', 'INR', 'Asia/Kolkata')
     ON CONFLICT (code) DO UPDATE SET name = organizations.name
     RETURNING id`,
  )
  return row?.id as string
}

/**
 * Removes everything the workspace holds except the organization itself and the
 * admin logins below.
 *
 * Order follows the foreign keys: generated payroll first, then the records it
 * reads, then people, then the configuration they were filed under. Only rows
 * belonging to this organization are touched.
 */
async function clearWorkspace(tx: Queryable, organizationId: string): Promise<void> {
  const orgScoped = [
    // Generated from other data.
    'payroll_adjustments',
    'payroll_runs',
    'employee_bonuses',
    'attendance',
    'leave_requests',
    'employee_leave_balances',
    // People and what hangs off them.
    'employee_salary_assignments',
    'employee_bank_accounts',
    'employee_job_history',
    'employee_documents',
    'employee_shift_assignments',
    // Configuration.
    'leave_policies',
    'leave_types',
    'weekly_off_rules',
    'holidays',
    'holiday_calendars',
    'shifts',
    'salary_structures',
    'salary_components',
    'bonus_types',
    'tax_slabs',
    'designations',
    'departments',
    'locations',
    // Messaging and audit trail for the removed data.
    'message_outbox',
    'message_broadcasts',
    'message_scenarios',
    'notifications',
    'audit_logs',
  ]

  // Not organization-scoped itself: reached through its parent structure, and
  // cleared first so the structures below it delete cleanly.
  await tx.query(
    `DELETE FROM salary_structure_components
      WHERE salary_structure_id IN (SELECT id FROM salary_structures WHERE organization_id = $1)`,
    [organizationId],
  )

  for (const table of orgScoped) {
    // A table may not exist yet on an older schema; the seed still has to run.
    try {
      await tx.query(`DELETE FROM ${table} WHERE organization_id = $1`, [organizationId])
    } catch (error) {
      logger.warn({ table, err: error }, 'Skipped clearing a table')
    }
  }

  // Employees last: everything above referenced them.
  await tx.query('DELETE FROM employees WHERE organization_id = $1', [organizationId])

  // Every user except the admin accounts this seed maintains.
  await tx.query(
    `DELETE FROM users WHERE organization_id = $1 AND lower(email) <> ALL($2::text[])`,
    [organizationId, ADMINS.map((admin) => admin.email.toLowerCase())],
  )
}

async function seedAdmins(tx: Queryable, organizationId: string, passwordHash: string): Promise<string[]> {
  const ids: string[] = []
  for (const admin of ADMINS) {
    const row = await queryOne<{ id: string }>(
      tx,
      // phone is cleared explicitly: an account carried over from the old
      // fixture would otherwise keep its sample number, and a stray number is
      // what WhatsApp would deliver to.
      `INSERT INTO users (organization_id, email, password_hash, role, full_name, phone, must_change_password)
       VALUES ($1, $2, $3, 'SUPER_ADMIN', $4, NULL, FALSE)
       ON CONFLICT (lower(email)) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = 'SUPER_ADMIN',
             full_name = EXCLUDED.full_name,
             phone = NULL,
             status = 'ACTIVE'
       RETURNING id`,
      [organizationId, admin.email, passwordHash, admin.fullName],
    )
    ids.push(row?.id as string)
  }
  return ids
}

async function main(): Promise<void> {
  if (isProduction) {
    throw new Error('Refusing to seed a production database. Seed data is for development only.')
  }

  logger.info('Applying migrations before seeding')
  await migrateUp()
  await syncPermissionCatalogue()

  const passwordHash = await hashPassword(DEFAULT_PASSWORD)

  await withTransaction(async (tx) => {
    const organizationId = await seedOrganization(tx)
    await clearWorkspace(tx, organizationId)
    await seedDefaultSlabs(organizationId, tx)
    await seedAdmins(tx, organizationId, passwordHash)
  })

  logger.info('Seed complete')
  process.stdout.write(
    [
      '',
      'The workspace is empty. Two Super Admin accounts were created:',
      `  Password:  ${DEFAULT_PASSWORD}`,
      ...ADMINS.map((admin) => `  Sign in:   ${admin.email}`),
      '',
      'Set the workspace up from Organization, then Salary, Calendar and Employees.',
      'These accounts are for development only. Never seed a production database.',
      '',
    ].join('\n'),
  )
}

const invokedDirectly = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false

if (invokedDirectly) {
  main()
    .then(async () => {
      await pool.end()
      process.exit(0)
    })
    .catch(async (error: unknown) => {
      logger.error({ err: error }, 'Seeding failed')
      await pool.end()
      process.exit(1)
    })
}
