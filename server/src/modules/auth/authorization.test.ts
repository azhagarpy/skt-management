import { describe, expect, it } from 'vitest'
import { PERMISSIONS, ROLE_PERMISSIONS, PERMISSION_DEFINITIONS, type PermissionCode } from './permissions.js'
import { checkPasswordStrength } from './password.service.js'
import { durationToMs, hashToken } from './token.service.js'
import { resolveScope, scopeClause } from '../employees/employee-access.js'
import type { AuthContext } from '../../types/express.js'

/**
 * Authorization tests (plan section 61: authentication, authorization and
 * document permissions).
 *
 * These cover the rules that decide who can see what, without needing a
 * database: the role permission sets, and the SQL scope predicate every list
 * endpoint folds into its query.
 */

const ORGANIZATION_ID = 'org-1'

function contextFor(role: 'SUPER_ADMIN' | 'SUPERVISOR' | 'EMPLOYEE', employeeId: string | null, extra: PermissionCode[] = []): AuthContext {
  const permissions = new Set<PermissionCode>([...(ROLE_PERMISSIONS[role] ?? []), ...extra])
  return {
    userId: `user-${role}`,
    organizationId: ORGANIZATION_ID,
    role,
    email: `${role.toLowerCase()}@example.com`,
    fullName: role,
    employeeId,
    permissions,
    has: (permission) => permissions.has(permission),
    hasAny: (...codes) => codes.some((code) => permissions.has(code)),
  }
}

const EMPLOYEE_VIEW = {
  all: PERMISSIONS.EMPLOYEE_VIEW_ALL,
  team: PERMISSIONS.EMPLOYEE_VIEW_TEAM,
  self: PERMISSIONS.EMPLOYEE_VIEW_SELF,
}

describe('role permission sets', () => {
  it('gives the Super Admin every permission in the catalogue', () => {
    expect(ROLE_PERMISSIONS.SUPER_ADMIN).toHaveLength(PERMISSION_DEFINITIONS.length)
  })

  it('does not give a supervisor organization-wide access', () => {
    const supervisor = ROLE_PERMISSIONS.SUPERVISOR
    expect(supervisor).not.toContain(PERMISSIONS.EMPLOYEE_VIEW_ALL)
    expect(supervisor).not.toContain(PERMISSIONS.ATTENDANCE_MANAGE_ALL)
    expect(supervisor).not.toContain(PERMISSIONS.PAYROLL_PROCESS)
    expect(supervisor).not.toContain(PERMISSIONS.USER_MANAGE)
    expect(supervisor).not.toContain(PERMISSIONS.AUDIT_VIEW)
    expect(supervisor).not.toContain(PERMISSIONS.SENSITIVE_DATA_VIEW)
  })

  it('withholds team salary from a supervisor until it is granted explicitly', () => {
    // Plan section 3: "View team salary/pay information only if explicitly permitted".
    expect(ROLE_PERMISSIONS.SUPERVISOR).not.toContain(PERMISSIONS.SALARY_VIEW_TEAM)
    expect(ROLE_PERMISSIONS.SUPERVISOR).not.toContain(PERMISSIONS.PAYROLL_VIEW_TEAM)
  })

  it('limits an employee to their own records', () => {
    const employee = ROLE_PERMISSIONS.EMPLOYEE
    expect(employee).toContain(PERMISSIONS.EMPLOYEE_VIEW_SELF)
    expect(employee).not.toContain(PERMISSIONS.EMPLOYEE_VIEW_ALL)
    expect(employee).not.toContain(PERMISSIONS.EMPLOYEE_VIEW_TEAM)
    expect(employee).not.toContain(PERMISSIONS.ATTENDANCE_MANAGE_ALL)
    expect(employee).not.toContain(PERMISSIONS.ATTENDANCE_MANAGE_TEAM)
    expect(employee).not.toContain(PERMISSIONS.LEAVE_APPROVE_TEAM)
    expect(employee).not.toContain(PERMISSIONS.REPORT_VIEW_ALL)
  })

  it('has no duplicate permission codes', () => {
    const codes = PERMISSION_DEFINITIONS.map((definition) => definition.code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('scope resolution', () => {
  it('resolves the widest scope the caller holds', () => {
    expect(resolveScope(contextFor('SUPER_ADMIN', null), EMPLOYEE_VIEW)).toBe('ALL')
    expect(resolveScope(contextFor('SUPERVISOR', 'emp-sup'), EMPLOYEE_VIEW)).toBe('TEAM')
    expect(resolveScope(contextFor('EMPLOYEE', 'emp-1'), EMPLOYEE_VIEW)).toBe('SELF')
  })

  it('refuses when the caller holds none of them', () => {
    const stripped = contextFor('EMPLOYEE', 'emp-1')
    stripped.permissions.delete(PERMISSIONS.EMPLOYEE_VIEW_SELF)
    expect(() => resolveScope(stripped, EMPLOYEE_VIEW)).toThrowError(/permission/i)
  })
})

describe('scope predicate', () => {
  it('scopes an administrator to their organization', () => {
    const clause = scopeClause(contextFor('SUPER_ADMIN', null), 'ALL', 'e', 1)
    expect(clause.sql).toBe('e.organization_id = $1')
    expect(clause.params).toEqual([ORGANIZATION_ID])
  })

  it('scopes a supervisor to their own team plus themselves', () => {
    const clause = scopeClause(contextFor('SUPERVISOR', 'emp-sup'), 'TEAM', 'e', 1)
    expect(clause.sql).toContain('e.supervisor_id = $2')
    expect(clause.sql).toContain('e.id = $2')
    expect(clause.sql).toContain('e.organization_id = $1')
    expect(clause.params).toEqual([ORGANIZATION_ID, 'emp-sup'])
  })

  it('scopes an employee to exactly themselves', () => {
    const clause = scopeClause(contextFor('EMPLOYEE', 'emp-1'), 'SELF', 'e', 1)
    expect(clause.sql).toBe('e.organization_id = $1 AND e.id = $2')
    expect(clause.params).toEqual([ORGANIZATION_ID, 'emp-1'])
  })

  it('matches nothing when the account has no employee record', () => {
    // A supervisor account not linked to an employee supervises nobody, and must
    // not fall through to seeing everyone.
    expect(scopeClause(contextFor('SUPERVISOR', null), 'TEAM', 'e', 1)).toEqual({ sql: 'FALSE', params: [] })
    expect(scopeClause(contextFor('EMPLOYEE', null), 'SELF', 'e', 1)).toEqual({ sql: 'FALSE', params: [] })
  })

  it('honours the placeholder offset so filters can be appended', () => {
    const clause = scopeClause(contextFor('SUPERVISOR', 'emp-sup'), 'TEAM', 'x', 5)
    expect(clause.sql).toContain('x.organization_id = $5')
    expect(clause.sql).toContain('x.supervisor_id = $6')
  })
})

describe('permission overrides', () => {
  it('lets a granted permission widen a supervisor without changing their role', () => {
    const supervisor = contextFor('SUPERVISOR', 'emp-sup', [PERMISSIONS.SALARY_VIEW_TEAM])
    expect(supervisor.role).toBe('SUPERVISOR')
    expect(supervisor.has(PERMISSIONS.SALARY_VIEW_TEAM)).toBe(true)
    expect(supervisor.has(PERMISSIONS.SALARY_VIEW_ALL)).toBe(false)

    const scope = resolveScope(supervisor, {
      all: PERMISSIONS.SALARY_VIEW_ALL,
      team: PERMISSIONS.SALARY_VIEW_TEAM,
      self: PERMISSIONS.SALARY_VIEW_SELF,
    })
    expect(scope).toBe('TEAM')
  })
})

describe('password rules', () => {
  it('accepts a strong password', () => {
    expect(checkPasswordStrength('Passw0rd!123').valid).toBe(true)
  })

  it('explains every rule a weak password breaks', () => {
    const result = checkPasswordStrength('short')
    expect(result.valid).toBe(false)
    expect(result.problems.length).toBeGreaterThan(1)
    expect(result.problems.some((problem) => problem.includes('10 characters'))).toBe(true)
  })

  it('requires mixed case, a digit and a symbol', () => {
    expect(checkPasswordStrength('alllowercase1!').valid).toBe(false)
    expect(checkPasswordStrength('ALLUPPERCASE1!').valid).toBe(false)
    expect(checkPasswordStrength('NoDigitsHere!!').valid).toBe(false)
    expect(checkPasswordStrength('NoSymbols12345').valid).toBe(false)
  })
})

describe('tokens', () => {
  it('hashes refresh tokens deterministically and irreversibly', () => {
    const hash = hashToken('a-refresh-token')
    expect(hash).toHaveLength(64)
    expect(hash).toBe(hashToken('a-refresh-token'))
    expect(hash).not.toContain('a-refresh-token')
    expect(hashToken('a-refresh-tokeo')).not.toBe(hash)
  })

  it('parses the durations used for token lifetimes', () => {
    expect(durationToMs('15m')).toBe(900_000)
    expect(durationToMs('7d')).toBe(604_800_000)
    expect(durationToMs('30s')).toBe(30_000)
    expect(durationToMs('3600')).toBe(3_600_000)
    expect(() => durationToMs('soon')).toThrowError()
  })
})
