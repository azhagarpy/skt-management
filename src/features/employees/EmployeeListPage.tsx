import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Plus, Upload } from 'lucide-react'
import { download, getWithMeta, upload } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { Avatar, Badge, Button, Card, Field, Modal, PageHeader, Pagination, ProgressBar, SearchInput, Select, StatusBadge } from '../../components/ui'
import { useToast } from '../../app/providers/ToastProvider'
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
interface ImportProblem {
  rowNumber: number
  employeeCode: string
  message: string
}

interface ImportPreview {
  totalRows: number
  readyCount: number
  problems: ImportProblem[]
  ignoredColumns: string[]
}

export default function EmployeeListPage() {
  const navigate = useNavigate()
  const { can } = useAuth()
  const toast = useToast()
  const queryClient = useQueryClient()

  // Bulk import. The file is previewed before anything is written, so every
  // bad row can be fixed in one pass rather than one upload per mistake.
  const importFileRef = useRef<HTMLInputElement | null>(null)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)

  const previewMutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return upload<ImportPreview>('/employees/import/preview', formData)
    },
    onSuccess: (response) => setPreview(response.data),
    onError: (error: Error) => {
      setImportFile(null)
      toast.error('Could not read the file', error.message)
    },
  })

  const commitMutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return upload<{ created: number }>('/employees/import', formData)
    },
    onSuccess: async (response) => {
      toast.success(`${response.data.created} employee(s) imported`)
      closeImport()
      await queryClient.invalidateQueries({ queryKey: ['employees'] })
    },
    onError: (error: Error) => toast.error('Import failed', error.message),
  })

  function closeImport() {
    setImportFile(null)
    setPreview(null)
  }

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
              <Button variant="secondary" icon={<Upload size={15} />} onClick={() => importFileRef.current?.click()}>
                Bulk import
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

      <input
        ref={importFileRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null
          event.target.value = ''
          if (!file) return
          setImportFile(file)
          setPreview(null)
          previewMutation.mutate(file)
        }}
      />

      <Modal
        open={importFile !== null}
        title="Bulk import employees"
        onClose={closeImport}
        footer={
          <>
            <Button variant="secondary" onClick={closeImport}>
              Cancel
            </Button>
            <Button
              loading={commitMutation.isPending}
              disabled={!preview || preview.problems.length > 0 || preview.readyCount === 0}
              onClick={() => importFile && commitMutation.mutate(importFile)}
            >
              Import {preview?.readyCount ?? 0} employee(s)
            </Button>
          </>
        }
      >
        {previewMutation.isPending ? (
          <p>Reading {importFile?.name}…</p>
        ) : preview ? (
          <div className="stack" style={{ gap: '0.75rem' }}>
            <p style={{ margin: 0 }}>
              <strong>{importFile?.name}</strong> — {preview.totalRows} row(s), {preview.readyCount} ready to import.
            </p>

            {preview.ignoredColumns.length > 0 ? (
              <p className="subtle" style={{ margin: 0 }}>
                Columns ignored: {preview.ignoredColumns.join(', ')}
              </p>
            ) : null}

            {preview.problems.length > 0 ? (
              <>
                <p style={{ margin: 0, color: 'var(--danger, #b00)' }}>
                  {preview.problems.length} problem(s). Nothing is imported until every one is fixed.
                </p>
                <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Employee ID</th>
                        <th>Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.problems.map((problem, index) => (
                        <tr key={`${problem.rowNumber}-${index}`}>
                          <td>{problem.rowNumber}</td>
                          <td>{problem.employeeCode || '—'}</td>
                          <td>{problem.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p style={{ margin: 0 }}>No problems found. The file is ready to import.</p>
            )}

            <p className="subtle" style={{ margin: 0, fontSize: '0.85rem' }}>
              Upload the Employee Master export from Reports. Departments, sections and supply types must already exist.
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
