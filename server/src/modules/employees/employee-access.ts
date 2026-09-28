import { pool, type Queryable } from '../../database/pool.js'
import { ApiError } from '../../utils/api-error.js'
import type { PermissionCode } from '../auth/permissions.js'
import type { AuthContext } from '../../types/express.js'

/**
 * How much of the employee population a request may reach.
 *
 * Every list endpoint resolves a scope and folds it into its WHERE clause, and
 * every by-id endpoint asserts the target falls inside it. That is what stops a
 * supervisor reading another team, and an employee reading anyone but themselves
 * (plan sections 38 and 63).
 */
export type EmployeeScope = 'ALL' | 'TEAM' | 'SELF'

export interface ScopePermissions {
  all: PermissionCode
  team?: PermissionCode
  self?: PermissionCode
}

export function resolveScope(auth: AuthContext, permissions: ScopePermissions): EmployeeScope {
  if (auth.has(permissions.all)) return 'ALL'
  if (permissions.team && auth.has(permissions.team)) return 'TEAM'
  if (permissions.self && auth.has(permissions.self)) return 'SELF'
  throw ApiError.forbidden('You do not have permission to view this information')
}

export interface ScopeClause {
  /** SQL predicate to AND into a query, using `$n` placeholders. */
  sql: string
  params: unknown[]
}

/**
 * Builds the SQL predicate for a scope.
 *
 * `employeeAlias` is the alias of the employees table in the caller's query.
 * `startIndex` is the next free `$n` placeholder number.
 */
export function scopeClause(
  auth: AuthContext,
  scope: EmployeeScope,
  employeeAlias: string,
  startIndex: number,
): ScopeClause {
  if (scope === 'ALL') {
    return { sql: `${employeeAlias}.organization_id = $${startIndex}`, params: [auth.organizationId] }
  }

  if (scope === 'TEAM') {
    if (!auth.employeeId) {
      // A supervisor account with no employee record supervises nobody.
      return { sql: 'FALSE', params: [] }
    }
    // A team is everyone the caller supervises, plus - for a manager - the
    // supervisors assigned to them and everyone those supervisors look after.
    // The caller's own record is included so they can see themselves in team
    // views. For a supervisor the manager branches match nobody.
    const me = `$${startIndex + 1}`
    return {
      sql: `${employeeAlias}.organization_id = $${startIndex}
            AND (${employeeAlias}.supervisor_id = ${me}
                 OR ${employeeAlias}.id = ${me}
                 OR ${employeeAlias}.manager_id = ${me}
                 OR ${employeeAlias}.supervisor_id IN (SELECT m.id FROM employees m WHERE m.manager_id = ${me}))`,
      params: [auth.organizationId, auth.employeeId],
    }
  }

  if (!auth.employeeId) return { sql: 'FALSE', params: [] }
  return {
    sql: `${employeeAlias}.organization_id = $${startIndex} AND ${employeeAlias}.id = $${startIndex + 1}`,
    params: [auth.organizationId, auth.employeeId],
  }
}

/**
 * Confirms the actor may act on `employeeId` under `scope`, and that the
 * employee belongs to the actor's organization. Throws 404 rather than 403 when
 * the employee is outside the organization, so the API does not confirm the
 * existence of records in other tenants.
 */
export async function assertEmployeeInScope(
  auth: AuthContext,
  employeeId: string,
  scope: EmployeeScope,
  db: Queryable = pool,
): Promise<void> {
  const { rows } = await db.query<{
    id: string
    supervisor_id: string | null
    manager_id: string | null
    supervisor_manager_id: string | null
  }>(
    `SELECT e.id, e.supervisor_id, e.manager_id, s.manager_id AS supervisor_manager_id
       FROM employees e
       LEFT JOIN employees s ON s.id = e.supervisor_id
      WHERE e.id = $1 AND e.organization_id = $2`,
    [employeeId, auth.organizationId],
  )
  const employee = rows[0]
  if (!employee) throw ApiError.notFound('Employee')

  if (scope === 'ALL') return

  if (scope === 'TEAM') {
    if (!auth.employeeId) throw ApiError.forbidden('Your account is not linked to an employee record')
    if (isTeamMember(employee, auth.employeeId)) return
    throw ApiError.forbidden('This employee is not assigned to you')
  }

  if (!auth.employeeId || employee.id !== auth.employeeId) {
    throw ApiError.forbidden('You can only access your own records')
  }
}

/**
 * The in-memory twin of the TEAM predicate in `scopeClause`: the employee is
 * the caller, reports to them, is a supervisor assigned to them as manager, or
 * reports to such a supervisor.
 */
export function isTeamMember(
  employee: { id: string; supervisor_id: string | null; manager_id: string | null; supervisor_manager_id: string | null },
  callerEmployeeId: string,
): boolean {
  return (
    employee.id === callerEmployeeId ||
    employee.supervisor_id === callerEmployeeId ||
    employee.manager_id === callerEmployeeId ||
    employee.supervisor_manager_id === callerEmployeeId
  )
}

/** Resolves the acting user's own employee id, or fails with a clear message. */
export function requireOwnEmployeeId(auth: AuthContext): string {
  if (!auth.employeeId) {
    throw ApiError.businessRule('Your user account is not linked to an employee record')
  }
  return auth.employeeId
}

/**
 * Resolves the employee id a "me or explicit id" endpoint should act on.
 * `/employees/me` maps to the caller; an explicit id is scope-checked.
 */
export async function resolveTargetEmployeeId(
  auth: AuthContext,
  requested: string | undefined,
  permissions: ScopePermissions,
  db: Queryable = pool,
): Promise<{ employeeId: string; scope: EmployeeScope }> {
  const scope = resolveScope(auth, permissions)
  if (!requested || requested === 'me') {
    return { employeeId: requireOwnEmployeeId(auth), scope }
  }
  await assertEmployeeInScope(auth, requested, scope, db)
  return { employeeId: requested, scope }
}
