import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getWithMeta } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { Avatar, Badge, Card, Field, PageHeader, Pagination, ProgressBar, SearchInput, StatTile, StatusBadge } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { DepartmentSelector } from '../../components/forms/selectors'
import type { EmployeeSummary } from '../../types/api'

/**
 * Supervisors (plan section 18).
 *
 * Supervisors are employees, so they carry the same document and profile
 * completion requirements; this view surfaces that alongside their team size.
 */
export default function SupervisorListPage() {
  const navigate = useNavigate()

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [departmentId, setDepartmentId] = useState('')

  const filters = {
    page,
    pageSize: 25,
    search: search || undefined,
    departmentId: departmentId || undefined,
    isSupervisor: true,
  }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['employees', 'supervisors', filters],
    queryFn: () => getWithMeta<EmployeeSummary[]>('/employees', filters),
    placeholderData: keepPreviousData,
  })

  // Team sizes come from a single wide fetch of active employees; supervision is
  // a shallow relationship, so this stays cheap.
  const { data: teamCounts } = useQuery({
    queryKey: ['employees', 'team-counts'],
    queryFn: async () => {
      const response = await getWithMeta<EmployeeSummary[]>('/employees', {
        pageSize: 200,
        employmentStatus: 'ACTIVE',
      })
      const counts = new Map<string, number>()
      for (const employee of response.data) {
        if (!employee.supervisorId) continue
        counts.set(employee.supervisorId, (counts.get(employee.supervisorId) ?? 0) + 1)
      }
      return counts
    },
    staleTime: 60_000,
  })

  const rows = data?.data ?? []

  const columns: Column<EmployeeSummary>[] = [
    {
      key: 'supervisor',
      header: 'Supervisor',
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
      key: 'team',
      header: 'Team size',
      align: 'right',
      render: (row) => {
        const count = teamCounts?.get(row.id) ?? 0
        return <Badge tone={count > 0 ? 'info' : 'neutral'}>{count}</Badge>
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
            <p className="subtle">{row.userRole}</p>
          </div>
        ) : (
          <span className="subtle">No login</span>
        ),
    },
    {
      key: 'profile',
      header: 'Documents',
      align: 'right',
      render: (row) => (
        <div style={{ minWidth: 100 }}>
          <ProgressBar
            value={row.profileCompletionPercent ?? 0}
            tone={(row.profileCompletionPercent ?? 0) === 100 ? 'success' : 'warning'}
          />
          <span className="subtle">{row.profileCompletionPercent ?? 0}%</span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.employmentStatus} /> },
    { key: 'joined', header: 'Joined', hideOnMobile: true, render: (row) => formatDate(row.joiningDate) },
  ]

  const incomplete = rows.filter((row) => (row.profileCompletionPercent ?? 0) < 100).length

  return (
    <div className="page">
      <PageHeader
        title="Supervisors"
        description="Supervisors manage a team, and carry the same document requirements as any other employee."
      />

      <div className="grid grid-4">
        <StatTile label="Supervisors" value={data?.meta?.total ?? rows.length} tone="info" />
        <StatTile label="With incomplete documents" value={incomplete} tone={incomplete > 0 ? 'warning' : 'success'} />
        <StatTile label="Without a login" value={rows.filter((row) => !row.userEmail).length} tone="neutral" />
      </div>

      <Card padded={false}>
        <div className="filter-bar">
          <SearchInput value={search} onChange={setSearch} placeholder="Name or employee ID" />
          <Field label="Department" htmlFor="supervisor-department">
            <DepartmentSelector id="supervisor-department" value={departmentId} onChange={setDepartmentId} />
          </Field>
        </div>

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          onRowClick={(row) => navigate(`/employees/${row.id}`)}
          emptyTitle="No supervisors yet"
          emptyDescription="Mark an employee as a supervisor to let them manage a team."
          caption="Supervisors"
        />

        {data?.meta ? (
          <Pagination
            page={data.meta.page ?? 1}
            pageSize={data.meta.pageSize ?? 25}
            total={data.meta.total ?? 0}
            totalPages={data.meta.totalPages ?? 1}
            onPageChange={setPage}
          />
        ) : null}
      </Card>
    </div>
  )
}
