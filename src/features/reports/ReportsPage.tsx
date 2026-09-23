import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download, FileSpreadsheet, FileText, FileType } from 'lucide-react'
import { download, getWithMeta, get } from '../../lib/api'
import { MONTH_NAMES, formatCurrency, formatDate, formatDays, formatNumber, todayIso } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  Spinner,
  StatusBadge,
} from '../../components/ui'
import { DepartmentSelector, SupervisorSelector } from '../../components/forms/selectors'
import type { ReportColumn, ReportDescriptor } from '../../types/api'

/**
 * Reports (plan sections 41 and 57).
 *
 * The catalogue is served by the API, including each report's columns and the
 * filters it accepts, so this one screen renders every report and its exports
 * without hard-coding any of them.
 */
export default function ReportsPage() {
  const toast = useToast()
  const { can } = useAuth()

  const now = new Date()
  const [selectedKey, setSelectedKey] = useState('')
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState<string | null>(null)
  const [filters, setFilters] = useState<Record<string, string>>({
    year: String(now.getFullYear()),
    month: String(now.getMonth() === 0 ? 12 : now.getMonth()),
    from: '',
    to: '',
    departmentId: '',
    supervisorId: '',
    employmentStatus: '',
    paymentStatus: '',
    leaveStatus: '',
    attendanceStatus: '',
  })

  const catalogueQuery = useQuery({
    queryKey: ['reports', 'catalogue'],
    queryFn: () => get<ReportDescriptor[]>('/reports'),
  })

  const reports = catalogueQuery.data ?? []
  const report = reports.find((entry) => entry.key === selectedKey) ?? reports[0]

  useEffect(() => {
    if (!selectedKey && reports[0]) setSelectedKey(reports[0].key)
  }, [reports, selectedKey])

  // Only send the filters this report actually accepts.
  const activeFilters = useMemo(() => {
    if (!report) return {}
    const result: Record<string, string | number> = {}
    for (const key of report.filters) {
      const value = filters[key]
      if (value) result[key] = value
    }
    return result
  }, [report, filters])

  const missingRequired = report?.requiredFilters.filter((key) => !filters[key]) ?? []

  const dataQuery = useQuery({
    queryKey: ['reports', report?.key, activeFilters, page],
    queryFn: () => getWithMeta<Record<string, unknown>[]>(`/reports/${report?.key}`, { ...activeFilters, page, pageSize: 50 }),
    enabled: Boolean(report) && missingRequired.length === 0,
    placeholderData: keepPreviousData,
  })

  const rows = dataQuery.data?.data ?? []
  const meta = dataQuery.data?.meta
  const columns = (meta?.columns as ReportColumn[] | undefined) ?? report?.columns ?? []
  const totals = (meta?.totals as Record<string, number> | undefined) ?? {}

  const setFilter = (key: string, value: string): void => {
    setFilters((current) => ({ ...current, [key]: value }))
    setPage(1)
  }

  const runExport = async (format: 'csv' | 'xlsx' | 'pdf' | 'ecr'): Promise<void> => {
    if (!report) return
    setExporting(format)
    try {
      // The PF text file is named for its month; the others for the day they were run.
      const filename =
        format === 'ecr'
          ? `pf-ecr-${filters.year}-${String(filters.month).padStart(2, '0')}.txt`
          : `${report.key}-${todayIso()}.${format}`
      const headers = await download(`/reports/${report.key}/export`, filename, { ...activeFilters, format })
      const skipped = Number(headers.get('X-Export-Skipped') ?? 0)
      if (format === 'ecr' && skipped > 0) {
        toast.info(
          `${skipped} employee${skipped === 1 ? ' was' : 's were'} left out`,
          'They have no UAN / PF number, or are not marked PF-applicable.',
        )
      }
    } catch (error) {
      toast.error('Export failed', error instanceof Error ? error.message : undefined)
    } finally {
      setExporting(null)
    }
  }

  const renderCell = (value: unknown, format: ReportColumn['format']): string => {
    if (value === null || value === undefined || value === '') return '—'
    switch (format) {
      case 'currency':
        return formatCurrency(Number(value))
      case 'days':
        return formatDays(Number(value))
      case 'number':
        return formatNumber(Number(value))
      case 'percent':
        return `${Number(value).toFixed(2)}%`
      case 'date':
        return formatDate(String(value))
      default:
        return String(value)
    }
  }

  const isStatusColumn = (key: string): boolean =>
    key.endsWith('_status') || key === 'status' || key === 'employment_status' || key === 'payment_status'

  if (catalogueQuery.isLoading) return <Spinner label="Loading reports" />

  return (
    <div className="page">
      <PageHeader
        title="Reports"
        description="Every report can be filtered and exported to CSV, Excel or PDF."
        actions={
          can('report.export') && report ? (
            <>
              <Button
                variant="secondary"
                icon={<Download size={15} />}
                loading={exporting === 'csv'}
                disabled={missingRequired.length > 0}
                onClick={() => void runExport('csv')}
              >
                CSV
              </Button>
              <Button
                variant="secondary"
                icon={<FileSpreadsheet size={15} />}
                loading={exporting === 'xlsx'}
                disabled={missingRequired.length > 0}
                onClick={() => void runExport('xlsx')}
              >
                Excel
              </Button>
              <Button
                variant="secondary"
                icon={<FileText size={15} />}
                loading={exporting === 'pdf'}
                disabled={missingRequired.length > 0}
                onClick={() => void runExport('pdf')}
              >
                PDF
              </Button>
              {report.key === 'pf-report' ? (
                <Button
                  variant="secondary"
                  icon={<FileType size={15} />}
                  loading={exporting === 'ecr'}
                  disabled={missingRequired.length > 0}
                  onClick={() => void runExport('ecr')}
                >
                  PF text (ECR)
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <Card padded={false}>
        <div className="filter-bar">
          <Field label="Report" htmlFor="report-key">
            <Select
              id="report-key"
              value={report?.key ?? ''}
              onChange={(event) => {
                setSelectedKey(event.target.value)
                setPage(1)
              }}
              style={{ minWidth: 220 }}
            >
              {reports.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Field>

          {report?.filters.includes('year') ? (
            <Field label="Year" htmlFor="report-year">
              <Select id="report-year" value={filters.year} onChange={(event) => setFilter('year', event.target.value)}>
                {Array.from({ length: 5 }, (_, index) => now.getFullYear() - index).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {report?.filters.includes('month') ? (
            <Field label="Month" htmlFor="report-month">
              <Select id="report-month" value={filters.month} onChange={(event) => setFilter('month', event.target.value)}>
                {MONTH_NAMES.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {report?.filters.includes('from') ? (
            <Field label="From" htmlFor="report-from">
              <Input id="report-from" type="date" value={filters.from} onChange={(event) => setFilter('from', event.target.value)} />
            </Field>
          ) : null}

          {report?.filters.includes('to') ? (
            <Field label="To" htmlFor="report-to">
              <Input id="report-to" type="date" value={filters.to} onChange={(event) => setFilter('to', event.target.value)} />
            </Field>
          ) : null}

          {report?.filters.includes('departmentId') ? (
            <Field label="Department" htmlFor="report-department">
              <DepartmentSelector
                id="report-department"
                value={filters.departmentId ?? ''}
                onChange={(value) => setFilter('departmentId', value)}
              />
            </Field>
          ) : null}

          {report?.filters.includes('supervisorId') ? (
            <Field label="Supervisor" htmlFor="report-supervisor">
              <SupervisorSelector
                id="report-supervisor"
                value={filters.supervisorId ?? ''}
                onChange={(value) => setFilter('supervisorId', value)}
              />
            </Field>
          ) : null}

          {report?.filters.includes('paymentStatus') ? (
            <Field label="Payment status" htmlFor="report-payment-status">
              <Select
                id="report-payment-status"
                value={filters.paymentStatus}
                onChange={(event) => setFilter('paymentStatus', event.target.value)}
              >
                <option value="">All</option>
                <option value="PENDING">Pending</option>
                <option value="PARTIALLY_PAID">Partially paid</option>
                <option value="PAID">Paid</option>
              </Select>
            </Field>
          ) : null}

          {report?.filters.includes('leaveStatus') ? (
            <Field label="Leave status" htmlFor="report-leave-status">
              <Select
                id="report-leave-status"
                value={filters.leaveStatus}
                onChange={(event) => setFilter('leaveStatus', event.target.value)}
              >
                <option value="">All</option>
                <option value="PENDING">Pending</option>
                <option value="APPROVED">Approved</option>
                <option value="REJECTED">Rejected</option>
                <option value="CANCELLED">Cancelled</option>
              </Select>
            </Field>
          ) : null}

          {report?.filters.includes('attendanceStatus') ? (
            <Field label="Attendance status" htmlFor="report-attendance-status">
              <Select
                id="report-attendance-status"
                value={filters.attendanceStatus}
                onChange={(event) => setFilter('attendanceStatus', event.target.value)}
              >
                <option value="">All</option>
                <option value="PRESENT">Present</option>
                <option value="ABSENT">Absent</option>
                <option value="ON_LEAVE">On leave</option>
                <option value="HALF_DAY_LEAVE">Half day</option>
                <option value="HOLIDAY">Holiday</option>
                <option value="WEEKLY_OFF">Weekly off</option>
              </Select>
            </Field>
          ) : null}

          {report?.filters.includes('employmentStatus') ? (
            <Field label="Employment status" htmlFor="report-employment-status">
              <Select
                id="report-employment-status"
                value={filters.employmentStatus}
                onChange={(event) => setFilter('employmentStatus', event.target.value)}
              >
                <option value="">All</option>
                <option value="ACTIVE">Active</option>
                <option value="ON_NOTICE">On notice</option>
                <option value="RESIGNED">Resigned</option>
                <option value="TERMINATED">Terminated</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            </Field>
          ) : null}
        </div>

        {report ? <p className="subtle" style={{ padding: '0.75rem 1.25rem 0' }}>{report.description}</p> : null}

        {missingRequired.length > 0 ? (
          <div style={{ padding: '1.25rem' }}>
            <div className="alert alert-info">
              Choose {missingRequired.join(' and ')} to run this report.
            </div>
          </div>
        ) : dataQuery.isFetching && rows.length === 0 ? (
          <Spinner label="Running the report" />
        ) : rows.length === 0 ? (
          <p className="muted" style={{ padding: '2.5rem', textAlign: 'center' }}>
            No rows match these filters.
          </p>
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table">
              <caption className="sr-only">{report?.name}</caption>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column.key}
                      className={column.format === 'currency' || column.format === 'days' || column.format === 'number' ? 'align-right' : ''}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    {columns.map((column) => {
                      const value = row[column.key]
                      const numeric = column.format === 'currency' || column.format === 'days' || column.format === 'number'
                      return (
                        <td key={column.key} data-label={column.label} className={numeric ? 'align-right' : ''}>
                          {isStatusColumn(column.key) && typeof value === 'string' ? (
                            <StatusBadge status={value} />
                          ) : (
                            renderCell(value, column.format)
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
              {Object.keys(totals).length > 0 ? (
                <tfoot>
                  <tr>
                    {columns.map((column, index) => {
                      const numeric = column.format === 'currency' || column.format === 'days' || column.format === 'number'
                      return (
                        <td key={column.key} data-label={column.label} className={numeric ? 'align-right' : ''}>
                          {index === 0 ? 'Total' : column.total ? renderCell(totals[column.key], column.format) : ''}
                        </td>
                      )
                    })}
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        )}

        {meta && rows.length > 0 ? (
          <Pagination
            page={(meta.page as number) ?? 1}
            pageSize={(meta.pageSize as number) ?? 50}
            total={(meta.total as number) ?? 0}
            totalPages={(meta.totalPages as number) ?? 1}
            onPageChange={setPage}
          />
        ) : null}
      </Card>

      <Card title="Available reports" padded={false}>
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Report</th>
                <th>Category</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((entry) => (
                <tr
                  key={entry.key}
                  className="clickable"
                  onClick={() => {
                    setSelectedKey(entry.key)
                    setPage(1)
                  }}
                >
                  <td data-label="Report">
                    <strong>{entry.name}</strong>
                  </td>
                  <td data-label="Category">
                    <Badge tone="neutral">{entry.category}</Badge>
                  </td>
                  <td data-label="Description">
                    <span className="subtle">{entry.description}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
