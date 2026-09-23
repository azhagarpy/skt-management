import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { download, getWithMeta } from '../../lib/api'
import { useAuth } from '../../app/providers/AuthProvider'
import {
  Badge,
  Button,
  Card,
  Field,
  PageHeader,
  Pagination,
  ProgressBar,
  SearchInput,
  Select,
  StatTile,
} from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { DepartmentSelector } from '../../components/forms/selectors'
import type { EmployeeSummary } from '../../types/api'

/**
 * Document verification queue.
 *
 * Rather than a flat list of files, this is organised by employee: the reviewer
 * sees who is missing what, and opens a profile to verify or reject each
 * section (plan sections 12 and 13).
 */
export default function DocumentReviewPage() {
  const navigate = useNavigate()
  const { can } = useAuth()

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [completeness, setCompleteness] = useState('incomplete')

  const filters = {
    page,
    pageSize: 25,
    search: search || undefined,
    departmentId: departmentId || undefined,
    employmentStatus: 'ACTIVE',
  }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['employees', 'documents', filters],
    queryFn: () => getWithMeta<EmployeeSummary[]>('/employees', filters),
    placeholderData: keepPreviousData,
  })

  const allRows = data?.data ?? []
  const rows =
    completeness === 'incomplete'
      ? allRows.filter((row) => (row.profileCompletionPercent ?? 0) < 100)
      : completeness === 'complete'
        ? allRows.filter((row) => (row.profileCompletionPercent ?? 0) === 100)
        : allRows

  const incompleteCount = allRows.filter((row) => (row.profileCompletionPercent ?? 0) < 100).length

  const columns: Column<EmployeeSummary>[] = [
    {
      key: 'employee',
      header: 'Employee',
      render: (row) => (
        <div>
          <strong>{row.fullName}</strong>
          <p className="subtle">
            {row.employeeCode}
            {row.departmentName ? ` · ${row.departmentName}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'completion',
      header: 'Profile completion',
      render: (row) => (
        <div style={{ minWidth: 140 }}>
          <ProgressBar
            value={row.profileCompletionPercent ?? 0}
            tone={(row.profileCompletionPercent ?? 0) === 100 ? 'success' : 'warning'}
          />
          <span className="subtle">{row.profileCompletionPercent ?? 0}%</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        (row.profileCompletionPercent ?? 0) === 100 ? (
          <Badge tone="success">Complete</Badge>
        ) : (
          <Badge tone="warning">Needs documents</Badge>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <Button
          size="sm"
          variant="secondary"
          onClick={(event) => {
            event.stopPropagation()
            navigate(`/employees/${row.id}`)
          }}
        >
          Review
        </Button>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="Documents"
        description="Who still owes documents, and whose submissions are waiting to be verified."
        actions={
          can('report.export') ? (
            <Button
              variant="secondary"
              icon={<Download size={15} />}
              onClick={() =>
                void download('/reports/employee-document-status/export', 'document-status.xlsx', {
                  format: 'xlsx',
                  departmentId: departmentId || undefined,
                })
              }
            >
              Export
            </Button>
          ) : null
        }
      />

      <div className="grid grid-4">
        <StatTile label="Employees shown" value={allRows.length} tone="info" />
        <StatTile label="Incomplete profiles" value={incompleteCount} tone={incompleteCount > 0 ? 'warning' : 'success'} />
      </div>

      <Card padded={false}>
        <div className="filter-bar">
          <SearchInput value={search} onChange={setSearch} placeholder="Name or employee ID" />

          <Field label="Department" htmlFor="doc-department">
            <DepartmentSelector id="doc-department" value={departmentId} onChange={setDepartmentId} />
          </Field>

          <Field label="Show" htmlFor="doc-completeness">
            <Select id="doc-completeness" value={completeness} onChange={(event) => setCompleteness(event.target.value)}>
              <option value="incomplete">Incomplete profiles</option>
              <option value="complete">Complete profiles</option>
              <option value="all">Everyone</option>
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
          emptyTitle={completeness === 'incomplete' ? 'Every profile is complete' : 'No employees match these filters'}
          emptyDescription={completeness === 'incomplete' ? 'Nothing is waiting on documents right now.' : undefined}
          caption="Document status by employee"
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
