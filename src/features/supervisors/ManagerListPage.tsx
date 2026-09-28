import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UsersRound } from 'lucide-react'
import { get, getWithMeta, put } from '../../lib/api'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Avatar, Badge, Button, Card, Modal, PageHeader, SearchInput, StatTile } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import type { EmployeeSummary } from '../../types/api'

/**
 * Managers: the level above supervisors.
 *
 * A manager oversees a set of supervisors and, through them, every employee on
 * those supervisors' teams. An administrator marks an employee as a manager on
 * the employee form, gives them a login with the Manager role, and assigns
 * their supervisors here.
 */
export default function ManagerListPage() {
  const navigate = useNavigate()
  const { canAny } = useAuth()
  const canAssign = canAny('supervisor.manage')
  const [assigning, setAssigning] = useState<EmployeeSummary | null>(null)

  const { data: managers, isFetching, error, refetch } = useQuery({
    queryKey: ['managers', 'options'],
    queryFn: () => get<EmployeeSummary[]>('/employees/managers'),
  })

  // Every active supervisor, to count each manager's supervisors and to pick from.
  const { data: supervisors } = useQuery({
    queryKey: ['employees', 'all-supervisors'],
    queryFn: async () =>
      (await getWithMeta<EmployeeSummary[]>('/employees', { isSupervisor: true, employmentStatus: 'ACTIVE', pageSize: 200 }))
        .data,
    staleTime: 60_000,
  })

  const supervisorsByManager = useMemo(() => {
    const map = new Map<string, EmployeeSummary[]>()
    for (const supervisor of supervisors ?? []) {
      if (!supervisor.managerId) continue
      map.set(supervisor.managerId, [...(map.get(supervisor.managerId) ?? []), supervisor])
    }
    return map
  }, [supervisors])

  const rows = managers ?? []
  const unassigned = (supervisors ?? []).filter((supervisor) => !supervisor.managerId).length

  const columns: Column<EmployeeSummary>[] = [
    {
      key: 'manager',
      header: 'Manager',
      render: (row) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <Avatar name={row.fullName} size={32} />
          <div>
            <strong>{row.fullName}</strong>
            <p className="subtle">
              {row.employeeCode}
              {row.designationName ? ` · ${row.designationName}` : ''}
            </p>
          </div>
        </div>
      ),
    },
    { key: 'department', header: 'Department', hideOnMobile: true, render: (row) => row.departmentName ?? '—' },
    {
      key: 'supervisors',
      header: 'Supervisors',
      render: (row) => {
        const list = supervisorsByManager.get(row.id) ?? []
        if (list.length === 0) return <span className="subtle">None assigned</span>
        return (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.3rem' }}>
            {list.map((supervisor) => (
              <Badge key={supervisor.id} tone="info">
                {supervisor.fullName}
              </Badge>
            ))}
          </span>
        )
      },
    },
    {
      key: 'login',
      header: 'Login',
      hideOnMobile: true,
      render: (row) =>
        row.userEmail ? (
          <div>
            <span>{row.userEmail}</span>
            <p className="subtle">{row.userRole === 'MANAGER' ? 'Manager' : (row.userRole ?? '')}</p>
          </div>
        ) : (
          <span className="subtle">No login</span>
        ),
    },
    ...(canAssign
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            render: (row: EmployeeSummary) => (
              <Button
                size="sm"
                variant="secondary"
                onClick={(event) => {
                  event.stopPropagation()
                  setAssigning(row)
                }}
              >
                Assign supervisors
              </Button>
            ),
          },
        ]
      : []),
  ]

  return (
    <div className="page">
      <PageHeader
        title="Managers"
        description="Managers oversee a set of supervisors and everyone in those supervisors' teams. Mark an employee as a manager on their profile and give them a login with the Manager role."
      />

      <div className="grid grid-4">
        <StatTile label="Managers" value={rows.length} tone="info" icon={<UsersRound size={18} />} />
        <StatTile
          label="Supervisors without a manager"
          value={unassigned}
          tone={unassigned > 0 ? 'warning' : 'success'}
        />
        <StatTile
          label="Managers without a Manager login"
          value={rows.filter((row) => row.userRole !== 'MANAGER').length}
          tone="neutral"
        />
      </div>

      <Card padded={false}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          onRowClick={(row) => navigate(`/employees/${row.id}`)}
          emptyTitle="No managers yet"
          emptyDescription="Edit an employee and tick “Is a manager” to add one."
          caption="Managers"
        />
      </Card>

      {assigning ? (
        <AssignSupervisorsModal
          manager={assigning}
          supervisors={(supervisors ?? []).filter((supervisor) => supervisor.id !== assigning.id)}
          onClose={() => setAssigning(null)}
        />
      ) : null}
    </div>
  )
}

function AssignSupervisorsModal({
  manager,
  supervisors,
  onClose,
}: {
  manager: EmployeeSummary
  supervisors: EmployeeSummary[]
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(supervisors.filter((supervisor) => supervisor.managerId === manager.id).map((supervisor) => supervisor.id)),
  )

  const save = useMutation({
    mutationFn: () => put<EmployeeSummary[]>(`/employees/${manager.id}/managed-supervisors`, { supervisorIds: [...selected] }),
    onSuccess: async () => {
      toast.success('Supervisors assigned', `${selected.size} supervisor(s) now report to ${manager.fullName}.`)
      await queryClient.invalidateQueries({ queryKey: ['employees'] })
      await queryClient.invalidateQueries({ queryKey: ['managers'] })
      onClose()
    },
    onError: (mutationError: Error) => toast.error('Could not assign supervisors', mutationError.message),
  })

  const term = search.trim().toLowerCase()
  const visible = supervisors.filter(
    (supervisor) =>
      !term ||
      supervisor.fullName.toLowerCase().includes(term) ||
      supervisor.employeeCode.toLowerCase().includes(term) ||
      (supervisor.departmentName ?? '').toLowerCase().includes(term),
  )

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <Modal
      open
      size="lg"
      title={`Supervisors managed by ${manager.fullName}`}
      description="Ticked supervisors, and everyone on their teams, come under this manager. A supervisor can have only one manager, so ticking one that belongs to someone else moves them here."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save ({selected.size})
          </Button>
        </>
      }
    >
      <div className="stack">
        <SearchInput value={search} onChange={setSearch} placeholder="Name, employee ID or department" />
        {supervisors.length === 0 ? (
          <p className="muted">No active supervisors yet. Tick “Is a supervisor” on an employee first.</p>
        ) : (
          <div className="stack" style={{ gap: '0.25rem', maxHeight: 360, overflowY: 'auto' }}>
            {visible.map((supervisor) => {
              const elsewhere = supervisor.managerId && supervisor.managerId !== manager.id ? supervisor.managerName : null
              return (
                <label key={supervisor.id} className="breakdown-row" style={{ cursor: 'pointer' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={selected.has(supervisor.id)}
                      onChange={() => toggle(supervisor.id)}
                    />
                    <span>
                      {supervisor.fullName} <span className="subtle">· {supervisor.employeeCode}</span>
                      {supervisor.departmentName ? <span className="subtle"> · {supervisor.departmentName}</span> : null}
                    </span>
                  </span>
                  {elsewhere ? <Badge tone="warning">Now under {elsewhere}</Badge> : null}
                </label>
              )
            })}
            {visible.length === 0 ? <p className="muted">No supervisor matches that search.</p> : null}
          </div>
        )}
      </div>
    </Modal>
  )
}
