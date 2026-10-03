import { describe, expect, it } from 'vitest'
import { PERMISSIONS, ROLE_PERMISSIONS, PERMISSION_DEFINITIONS, type PermissionCode } from './permissions.js'
import { checkPasswordStrength } from './password.service.js'
import { durationToMs, hashToken } from './token.service.js'
import {
  assertCanManageEmployee,
  assertCanManageEmployees,
  isTeamMember,
  resolveScope,
  scopeClause,
} from '../employees/employee-access.js'
import type { Queryable } from '../../database/pool.js'
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

function contextFor(role: 'SUPER_ADMIN' | 'MANAGER' | 'SUPERVISOR' | 'EMPLOYEE', employeeId: string | null, extra: PermissionCode[] = []): AuthContext {
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

  it('lets a supervisor manage every module for their team', () => {
    const supervisor = ROLE_PERMISSIONS.SUPERVISOR
    const teamCodes = PERMISSION_DEFINITIONS.map((definition) => definition.code).filter(
      (code) => code.endsWith('.team') && code !== PERMISSIONS.SUPERVISOR_VIEW_TEAM,
    )
    for (const code of teamCodes) expect(supervisor).toContain(code)
  })

  it('keeps what is company-wide by nature with the Super Admin', () => {
    const supervisor = ROLE_PERMISSIONS.SUPERVISOR
    for (const code of [
      PERMISSIONS.EMPLOYEE_CREATE,
      PERMISSIONS.EMPLOYEE_UPDATE,
      PERMISSIONS.EMPLOYEE_DELETE,
      PERMISSIONS.SUPERVISOR_MANAGE,
      PERMISSIONS.SALARY_STRUCTURE_MANAGE,
      PERMISSIONS.SALARY_VIEW_ALL,
      PERMISSIONS.SALARY_MANAGE,
      PERMISSIONS.PAYROLL_VIEW_ALL,
      PERMISSIONS.PAYROLL_APPROVE,
      PERMISSIONS.PAYROLL_LOCK,
      PERMISSIONS.PAYROLL_UNLOCK,
      PERMISSIONS.PAYROLL_DELETE,
      PERMISSIONS.PAYROLL_ADJUST,
      PERMISSIONS.PAYSLIP_GENERATE,
      PERMISSIONS.PAYSLIP_VIEW_ALL,
      PERMISSIONS.PAYMENT_VIEW_ALL,
      PERMISSIONS.PAYMENT_MANAGE,
      PERMISSIONS.BONUS_VIEW,
      PERMISSIONS.BONUS_MANAGE,
      PERMISSIONS.TAX_VIEW,
      PERMISSIONS.TAX_MANAGE,
      PERMISSIONS.LWF_MANAGE,
      PERMISSIONS.PL_WAGES_MANAGE,
      PERMISSIONS.HOLIDAY_MANAGE,
      PERMISSIONS.LEAVE_POLICY_MANAGE,
      PERMISSIONS.SETTINGS_MANAGE,
      PERMISSIONS.DOCUMENT_DELETE,
    ]) {
      expect(supervisor).not.toContain(code)
    }
  })

  it('gives a manager everything a supervisor has, plus a view of their supervisors, and nothing organization-wide', () => {
    const manager = ROLE_PERMISSIONS.MANAGER
    for (const code of ROLE_PERMISSIONS.SUPERVISOR) expect(manager).toContain(code)
    expect(manager).toContain(PERMISSIONS.SUPERVISOR_VIEW_TEAM)
    expect(manager).not.toContain(PERMISSIONS.EMPLOYEE_VIEW_ALL)
    expect(manager).not.toContain(PERMISSIONS.SUPERVISOR_MANAGE)
    expect(manager).not.toContain(PERMISSIONS.SALARY_VIEW_ALL)
    expect(ROLE_PERMISSIONS.SUPERVISOR).not.toContain(PERMISSIONS.SUPERVISOR_VIEW_TEAM)
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
    expect(employee.filter((code) => code.endsWith('.team'))).toEqual([])
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

  it('scopes a manager to their supervisors and everyone those supervisors look after', () => {
    const clause = scopeClause(contextFor('MANAGER', 'emp-mgr'), 'TEAM', 'e', 1)
    expect(clause.sql).toContain('e.manager_id = $2')
    expect(clause.sql).toContain('e.supervisor_id IN (SELECT m.id FROM employees m WHERE m.manager_id = $2)')
    expect(clause.params).toEqual([ORGANIZATION_ID, 'emp-mgr'])
  })

  it('counts the same people as team members in memory as the SQL predicate does', () => {
    const base = { id: 'emp-x', supervisor_id: null, manager_id: null, supervisor_manager_id: null }
    expect(isTeamMember({ ...base, id: 'emp-mgr' }, 'emp-mgr')).toBe(true)
    expect(isTeamMember({ ...base, supervisor_id: 'emp-mgr' }, 'emp-mgr')).toBe(true)
    expect(isTeamMember({ ...base, manager_id: 'emp-mgr' }, 'emp-mgr')).toBe(true)
    expect(isTeamMember({ ...base, supervisor_id: 'emp-sup', supervisor_manager_id: 'emp-mgr' }, 'emp-mgr')).toBe(true)
    expect(isTeamMember({ ...base, supervisor_id: 'emp-sup', supervisor_manager_id: 'emp-other' }, 'emp-mgr')).toBe(false)
    expect(isTeamMember(base, 'emp-mgr')).toBe(false)
  })

  it('honours the placeholder offset so filters can be appended', () => {
    const clause = scopeClause(contextFor('SUPERVISOR', 'emp-sup'), 'TEAM', 'x', 5)
    expect(clause.sql).toContain('x.organization_id = $5')
    expect(clause.sql).toContain('x.supervisor_id = $6')
  })
})

describe('changing a team member', () => {
  /** A database stub that answers every query with `rows`. */
  const answering = (rows: unknown[]): Queryable =>
    ({ query: async () => ({ rows }) }) as unknown as Queryable
  const supervisor = contextFor('SUPERVISOR', 'emp-sup')
  const member = { id: 'emp-1', supervisor_id: 'emp-sup', manager_id: null, supervisor_manager_id: null }

  it('lets a supervisor change someone on their team', async () => {
    await expect(assertCanManageEmployee(supervisor, 'emp-1', 'TEAM', answering([member]))).resolves.toBeUndefined()
  })

  it('refuses someone outside their team', async () => {
    const outsider = { ...member, supervisor_id: 'emp-other' }
    await expect(assertCanManageEmployee(supervisor, 'emp-1', 'TEAM', answering([outsider]))).rejects.toThrow(
      /not assigned to you/,
    )
  })

  it('refuses their own records, though they are part of their own team', async () => {
    const self = { id: 'emp-sup', supervisor_id: null, manager_id: null, supervisor_manager_id: null }
    await expect(assertCanManageEmployee(supervisor, 'emp-sup', 'TEAM', answering([self]))).rejects.toThrow(
      /your own records/,
    )
  })

  it('lets an administrator change anyone, themselves included', async () => {
    const admin = contextFor('SUPER_ADMIN', 'emp-admin')
    const self = { id: 'emp-admin', supervisor_id: null, manager_id: null, supervisor_manager_id: null }
    await expect(assertCanManageEmployee(admin, 'emp-admin', 'ALL', answering([self]))).resolves.toBeUndefined()
  })

  it('refuses a batch when any one is outside the team, or is the caller', async () => {
    // The stub plays the scoped query: only emp-1 is found on the team.
    await expect(assertCanManageEmployees(supervisor, ['emp-1', 'emp-2'], 'TEAM', answering([{ id: 'emp-1' }]))).rejects.toThrow(
      /not assigned to you/,
    )
    await expect(
      assertCanManageEmployees(supervisor, ['emp-1', 'emp-sup'], 'TEAM', answering([{ id: 'emp-1' }, { id: 'emp-sup' }])),
    ).rejects.toThrow(/your own records/)
    await expect(assertCanManageEmployees(supervisor, ['emp-1'], 'TEAM', answering([{ id: 'emp-1' }]))).resolves.toBeUndefined()
  })

  it('never resolves a supervisor to the whole company for the money modules', () => {
    for (const [all, team] of [
      [PERMISSIONS.SALARY_MANAGE, PERMISSIONS.SALARY_MANAGE_TEAM],
      [PERMISSIONS.BONUS_MANAGE, PERMISSIONS.BONUS_MANAGE_TEAM],
      [PERMISSIONS.PAYMENT_MANAGE, PERMISSIONS.PAYMENT_MANAGE_TEAM],
      [PERMISSIONS.PAYROLL_ADJUST, PERMISSIONS.PAYROLL_ADJUST_TEAM],
      [PERMISSIONS.TAX_MANAGE, PERMISSIONS.TAX_MANAGE_TEAM],
      [PERMISSIONS.LWF_MANAGE, PERMISSIONS.LWF_MANAGE_TEAM],
      [PERMISSIONS.PL_WAGES_MANAGE, PERMISSIONS.PL_WAGES_MANAGE_TEAM],
      [PERMISSIONS.PAYSLIP_VIEW_ALL, PERMISSIONS.PAYSLIP_VIEW_TEAM],
    ] as const) {
      expect(resolveScope(supervisor, { all, team })).toBe('TEAM')
      expect(resolveScope(contextFor('MANAGER', 'emp-mgr'), { all, team })).toBe('TEAM')
    }
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
