import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, ShieldCheck, UserPlus } from 'lucide-react'
import { get, patch, post, put } from '../../lib/api'
import { formatDateTime, humanise } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  StatusBadge,
} from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import type { RoleKey } from '../../types/api'

interface UserRow {
  id: string
  email: string
  fullName: string
  phone: string | null
  role: RoleKey
  status: string
  mustChangePassword: boolean
  lastLoginAt: string | null
  employeeId: string | null
  employeeCode: string | null
}

interface PermissionDefinition {
  code: string
  module: string
  description: string
}

interface PermissionState {
  userId: string
  role: RoleKey
  roleDefaults: string[]
  overrides: { code: string; granted: boolean }[]
  effective: string[]
}

/**
 * User accounts and permissions (plan sections 3 and 38).
 *
 * Roles carry defaults; the permission editor layers per-user grants and denials
 * on top, which is how a supervisor is given team salary visibility without a
 * new role.
 */
export default function UsersPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can, user: currentUser } = useAuth()

  const [search, setSearch] = useState('')
  const [role, setRole] = useState('')
  const [creating, setCreating] = useState(false)
  const [permissionsFor, setPermissionsFor] = useState<UserRow | null>(null)
  const [resetFor, setResetFor] = useState<UserRow | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [form, setForm] = useState({ email: '', fullName: '', role: 'EMPLOYEE' as RoleKey, password: '' })

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['users', { search, role }],
    queryFn: () => get<UserRow[]>('/users', { search: search || undefined, role: role || undefined }),
  })

  const catalogueQuery = useQuery({
    queryKey: ['permissions', 'catalogue'],
    queryFn: () => get<{ permissions: PermissionDefinition[]; roleDefaults: Record<RoleKey, string[]> }>('/users/permissions/catalogue'),
    enabled: can('permission.manage'),
  })

  const permissionQuery = useQuery({
    queryKey: ['users', permissionsFor?.id, 'permissions'],
    queryFn: () => get<PermissionState>(`/users/${permissionsFor?.id}/permissions`),
    enabled: Boolean(permissionsFor),
  })

  const [draftOverrides, setDraftOverrides] = useState<Record<string, boolean>>({})

  const createMutation = useMutation({
    mutationFn: () => post('/users', { ...form, mustChangePassword: true }),
    onSuccess: async () => {
      toast.success('User created', 'They must change their password at first sign-in.')
      setCreating(false)
      setForm({ email: '', fullName: '', role: 'EMPLOYEE', password: '' })
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (mutationError: Error) => toast.error('Could not create the user', mutationError.message),
  })

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => patch(`/users/${id}`, { status }),
    onSuccess: async () => {
      toast.success('User updated')
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (mutationError: Error) => toast.error('Could not update the user', mutationError.message),
  })

  const resetMutation = useMutation({
    mutationFn: () => post(`/users/${resetFor?.id}/reset-password`, { password: newPassword, mustChangePassword: true }),
    onSuccess: () => {
      toast.success('Password reset', 'Every session for that user has been signed out.')
      setResetFor(null)
      setNewPassword('')
    },
    onError: (mutationError: Error) => toast.error('Could not reset the password', mutationError.message),
  })

  const permissionMutation = useMutation({
    mutationFn: () =>
      put(`/users/${permissionsFor?.id}/permissions`, {
        overrides: Object.entries(draftOverrides).map(([code, granted]) => ({ code, granted })),
      }),
    onSuccess: async () => {
      toast.success('Permissions updated')
      setPermissionsFor(null)
      setDraftOverrides({})
      await queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (mutationError: Error) => toast.error('Could not update permissions', mutationError.message),
  })

  const columns: Column<UserRow>[] = [
    {
      key: 'user',
      header: 'User',
      render: (row) => (
        <div>
          <strong>{row.fullName}</strong>
          <p className="subtle">{row.email}</p>
        </div>
      ),
    },
    { key: 'role', header: 'Role', render: (row) => <Badge tone={row.role === 'SUPER_ADMIN' ? 'accent' : 'info'}>{humanise(row.role)}</Badge> },
    {
      key: 'employee',
      header: 'Employee',
      hideOnMobile: true,
      render: (row) => row.employeeCode ?? <span className="subtle">Not linked</span>,
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'lastLogin',
      header: 'Last sign-in',
      hideOnMobile: true,
      render: (row) => (row.lastLoginAt ? formatDateTime(row.lastLoginAt) : <span className="subtle">Never</span>),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div style={{ display: 'inline-flex', gap: '0.3rem' }}>
          {can('permission.manage') && row.id !== currentUser?.id ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<ShieldCheck size={13} />}
              onClick={() => {
                setPermissionsFor(row)
                setDraftOverrides({})
              }}
            >
              Permissions
            </Button>
          ) : null}
          {can('user.manage') ? (
            <>
              <Button size="sm" variant="ghost" icon={<KeyRound size={13} />} onClick={() => setResetFor(row)}>
                Reset
              </Button>
              {row.id !== currentUser?.id ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    statusMutation.mutate({ id: row.id, status: row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })
                  }
                >
                  {row.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ),
    },
  ]

  const permissionState = permissionQuery.data
  const catalogue = catalogueQuery.data

  // Group the catalogue by module so the editor reads as sections.
  const modules = new Map<string, PermissionDefinition[]>()
  for (const definition of catalogue?.permissions ?? []) {
    const list = modules.get(definition.module) ?? []
    list.push(definition)
    modules.set(definition.module, list)
  }

  const isEffective = (code: string): boolean => {
    if (code in draftOverrides) return draftOverrides[code] as boolean
    const override = permissionState?.overrides.find((entry) => entry.code === code)
    if (override) return override.granted
    return permissionState?.roleDefaults.includes(code) ?? false
  }

  const isRoleDefault = (code: string): boolean => permissionState?.roleDefaults.includes(code) ?? false

  const toggle = (code: string): void => {
    const next = !isEffective(code)
    setDraftOverrides((current) => {
      const updated = { ...current }
      // Matching the role default means the override can be dropped entirely.
      if (next === isRoleDefault(code)) delete updated[code]
      else updated[code] = next
      return updated
    })
  }

  return (
    <div className="page">
      <PageHeader
        title="Users"
        description="Sign-in accounts and what each of them may do."
        actions={
          can('user.manage') ? (
            <Button icon={<UserPlus size={15} />} onClick={() => setCreating(true)}>
              Add user
            </Button>
          ) : null
        }
      />

      <Card padded={false}>
        <div className="filter-bar">
          <SearchInput value={search} onChange={setSearch} placeholder="Name or email" />
          <Field label="Role" htmlFor="user-role">
            <Select id="user-role" value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="">All roles</option>
              <option value="SUPER_ADMIN">Super Admin</option>
              <option value="SUPERVISOR">Supervisor</option>
              <option value="EMPLOYEE">Employee</option>
            </Select>
          </Field>
        </div>

        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          emptyTitle="No users match these filters"
          caption="User accounts"
        />
      </Card>

      <Modal
        open={creating}
        title="Add user"
        description="The user must change this password the first time they sign in."
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              loading={createMutation.isPending}
              disabled={!form.email || !form.fullName || form.password.length < 10}
              onClick={() => createMutation.mutate()}
            >
              Create user
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="Full name" htmlFor="user-name" required>
            <Input id="user-name" value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} />
          </Field>
          <Field label="Email" htmlFor="user-email" required>
            <Input id="user-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </Field>
          <Field label="Role" htmlFor="user-form-role" required>
            <Select id="user-form-role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as RoleKey })}>
              <option value="EMPLOYEE">Employee</option>
              <option value="SUPERVISOR">Supervisor</option>
              <option value="SUPER_ADMIN">Super Admin</option>
            </Select>
          </Field>
          <Field
            label="Temporary password"
            htmlFor="user-password"
            required
            hint="At least 10 characters with upper and lower case, a digit and a symbol."
          >
            <Input id="user-password" type="text" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={resetFor !== null}
        title={`Reset password for ${resetFor?.fullName ?? ''}`}
        description="Every active session for this user will be signed out."
        onClose={() => {
          setResetFor(null)
          setNewPassword('')
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setResetFor(null)
                setNewPassword('')
              }}
            >
              Cancel
            </Button>
            <Button loading={resetMutation.isPending} disabled={newPassword.length < 10} onClick={() => resetMutation.mutate()}>
              Reset password
            </Button>
          </>
        }
      >
        <Field label="New temporary password" htmlFor="reset-password" required>
          <Input id="reset-password" type="text" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </Field>
      </Modal>

      <Modal
        open={permissionsFor !== null}
        title={`Permissions for ${permissionsFor?.fullName ?? ''}`}
        description={`Role default: ${permissionsFor ? humanise(permissionsFor.role) : ''}. Ticking or unticking creates an override for this user only.`}
        size="lg"
        onClose={() => {
          setPermissionsFor(null)
          setDraftOverrides({})
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setPermissionsFor(null)
                setDraftOverrides({})
              }}
            >
              Cancel
            </Button>
            <Button loading={permissionMutation.isPending} onClick={() => permissionMutation.mutate()}>
              Save permissions
            </Button>
          </>
        }
      >
        {permissionQuery.isLoading || !permissionState ? (
          <p className="muted">Loading permissions…</p>
        ) : (
          <div className="stack">
            {[...modules.entries()].map(([module, definitions]) => (
              <div key={module}>
                <p className="field-label" style={{ textTransform: 'capitalize' }}>
                  {module}
                </p>
                <div className="stack" style={{ gap: '0.3rem', marginTop: '0.3rem' }}>
                  {definitions.map((definition) => {
                    const effective = isEffective(definition.code)
                    const isDefault = isRoleDefault(definition.code)
                    const overridden = effective !== isDefault
                    return (
                      <label key={definition.code} className="breakdown-row" style={{ cursor: 'pointer' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <input type="checkbox" checked={effective} onChange={() => toggle(definition.code)} />
                          <span>
                            {definition.description}
                            <span className="subtle"> · {definition.code}</span>
                          </span>
                        </span>
                        {overridden ? <Badge tone="warning">Override</Badge> : isDefault ? <Badge tone="neutral">Role default</Badge> : null}
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  )
}
