import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download, Plus } from 'lucide-react'
import { download, getWithMeta } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { Avatar, Badge, Button, Card, Field, PageHeader, Pagination, ProgressBar, SearchInput, Select, StatusBadge } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { DepartmentSelector, SupervisorSelector } from '../../components/forms/selectors'
import type { EmployeeSummary } from '../../types/api'

/**
 * The employee directory.
 *
 * Search, filtering, sorting and paging all happen on the server, so the page
 * never loads more than one page of rows regardless of headcount
 * (plan sections 58 and 59).
 */
export default function EmployeeListPage() {
  const navigate = useNavigate()
  const { can } = useAuth()

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [supervisorId, setSupervisorId] = useState('')
  const [employmentStatus, setEmploymentStatus] = useState('ACTIVE')
  const [sortBy, setSortBy] = useState('employeeCode')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')

  const filters = {
    page,
    pageSize: 25,
    search: search || undefined,
    departmentId: departmentId || undefined,
    supervisorId: supervisorId || undefined,
    employmentStatus: employmentStatus || undefined,
    sortBy,
    sortOrder,
  }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['employees', filters],
    queryFn: () => getWithMeta<EmployeeSummary[]>('/employees', filters),
    placeholderData: keepPreviousData,
  })

  const rows = data?.data ?? []
  const meta = data?.meta

  const resetToFirstPage = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value)
    setPage(1)
  }

  const columns: Column<EmployeeSummary>[] = [
    {
      key: 'employee',
      header: 'Employee',
      sortKey: 'employeeCode',
      render: (row) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <Avatar name={row.fullName} size={32} />
          <div>
            <Link to={`/employees/${row.id}`} onClick={(event) => event.stopPropagation()}>
              {row.fullName}
            </Link>
            <p className="subtle">{row.employeeCode}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'department',
      header: 'Department',
      sortKey: 'department',
      hideOnMobile: true,
      render: (row) => row.departmentName ?? <span className="subtle">Unassigned</span>,
    },
    {
      key: 'designation',
      header: 'Section',
      sortKey: 'designation',
      hideOnMobile: true,
      render: (row) => row.designationName ?? <span className="subtle">—</span>,
    },
    {
      key: 'supervisor',
      header: 'Supervisor',
      hideOnMobile: true,
      render: (row) => row.supervisorName ?? <span className="subtle">—</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'employmentStatus',
      render: (row) => (
        <span style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center' }}>
          <StatusBadge status={row.employmentStatus} />
          {row.isSupervisor ? <Badge tone="accent">Supervisor</Badge> : null}
        </span>
      ),
    },
    {
      key: 'joined',
      header: 'Joined',
      sortKey: 'joiningDate',
      hideOnMobile: true,
      render: (row) => formatDate(row.joiningDate),
    },
    {
      key: 'profile',
      header: 'Profile',
      align: 'right',
      render: (row) =>
        row.profileCompletionPercent === undefined ? (
          <span className="subtle">—</span>
        ) : (
          <div style={{ minWidth: 92 }}>
            <ProgressBar
              value={row.profileCompletionPercent}
              tone={row.profileCompletionPercent === 100 ? 'success' : 'warning'}
            />
            <span className="subtle">{row.profileCompletionPercent}%</span>
          </div>
        ),
    },
  ]

  const handleExport = async (): Promise<void> => {
    await download('/reports/employee-master/export', 'employee-master.csv', {
      format: 'csv',
      departmentId: departmentId || undefined,
      supervisorId: supervisorId || undefined,
      employmentStatus: employmentStatus || undefined,
    })
  }

  return (
    <div className="page">
      <PageHeader
        title="Employees"
        description="Everyone in the organization, with their department, supervisor and profile status."
        actions={
          <>
            {can('report.export') ? (
              <Button variant="secondary" icon={<Download size={15} />} onClick={handleExport}>
                Export
              </Button>
            ) : null}
            {can('employee.create') ? (
              <Link to="/employees/new">
                <Button icon={<Plus size={15} />}>Add employee</Button>
              </Link>
            ) : null}
          </>
        }
      />

      <Card padded={false}>
        <div className="filter-bar">
          <SearchInput value={search} onChange={resetToFirstPage(setSearch)} placeholder="Name, code, email or phone" />

          <Field label="Department" htmlFor="filter-department">
            <DepartmentSelector id="filter-department" value={departmentId} onChange={resetToFirstPage(setDepartmentId)} />
          </Field>

          <Field label="Supervisor" htmlFor="filter-supervisor">
            <SupervisorSelector id="filter-supervisor" value={supervisorId} onChange={resetToFirstPage(setSupervisorId)} />
          </Field>

          <Field label="Status" htmlFor="filter-status">
            <Select
              id="filter-status"
              value={employmentStatus}
              onChange={(event) => resetToFirstPage(setEmploymentStatus)(event.target.value)}
            >
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="ON_NOTICE">On notice</option>
              <option value="RESIGNED">Resigned</option>
              <option value="TERMINATED">Terminated</option>
              <option value="INACTIVE">Inactive</option>
            </Select>
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
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSortChange={(key, order) => {
            setSortBy(key)
            setSortOrder(order)
          }}
          emptyTitle="No employees match these filters"
          emptyDescription="Try widening the search, or clear the filters to see everyone."
          caption="Employee directory"
        />

        {meta ? (
          <Pagination
            page={meta.page ?? 1}
            pageSize={meta.pageSize ?? 25}
            total={meta.total ?? 0}
            totalPages={meta.totalPages ?? 1}
            onPageChange={setPage}
          />
        ) : null}
      </Card>
    </div>
  )
}
