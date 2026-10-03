import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download, FileSpreadsheet, FileText, FileType, Printer } from 'lucide-react'
import { download, fetchBlob, getWithMeta, get } from '../../lib/api'
import { MONTH_NAMES, formatCurrency, formatDate, formatDays, formatNumber, todayIso } from '../../lib/format'
import { printPdf } from '../../lib/print'
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
import { DepartmentMultiSelector, EmployeeSelector, MultiSelect, SupervisorSelector } from '../../components/forms/selectors'
import type { ReportColumn, ReportDescriptor } from '../../types/api'

/** The ways a report's period can be chosen, and the filters each one sends. */
type PeriodMode = 'month' | 'monthRange' | 'range'

const PERIOD_KEYS: Record<PeriodMode, string[]> = {
  month: ['year', 'month'],
  monthRange: ['fromMonth', 'toMonth'],
  range: ['from', 'to'],
}

const PERIOD_LABELS: Record<PeriodMode, string> = {
  month: 'Month',
  monthRange: 'Month range',
  range: 'Date range',
}

const PERIOD_MODES: PeriodMode[] = ['month', 'monthRange', 'range']

/** Each report's chosen columns, remembered in this browser only. */
const COLUMN_CHOICE_KEY = 'skt.reports.columns'

function loadColumnChoice(): Record<string, string[]> {
  try {
    const stored = window.localStorage.getItem(COLUMN_CHOICE_KEY)
    return stored ? (JSON.parse(stored) as Record<string, string[]>) : {}
  } catch {
    return {}
  }
}

function saveColumnChoice(choice: Record<string, string[]>): void {
  try {
    window.localStorage.setItem(COLUMN_CHOICE_KEY, JSON.stringify(choice))
  } catch {
    // Not remembered; the choice still applies until the page is left.
  }
}

const isNumeric = (format: ReportColumn['format']): boolean =>
  format === 'currency' || format === 'amount' || format === 'days' || format === 'number'

/**
 * Reports (plan sections 41 and 57).
 *
 * The catalogue is served by the API, including each report's columns and the
 * filters it accepts, so this one screen renders every report and its exports
 * without hard-coding any of them. The columns shown can be chosen, and the
 * exports and prints carry just those.
 */
export default function ReportsPage() {
  const toast = useToast()
  const { can } = useAuth()

  const now = new Date()
  const years = Array.from({ length: 6 }, (_, index) => now.getFullYear() + 1 - index)
  const [selectedKey, setSelectedKey] = useState('')
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState<string | null>(null)
  const [filters, setFilters] = useState<Record<string, string>>({
    year: String(now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()),
    month: String(now.getMonth() === 0 ? 12 : now.getMonth()),
    fromMonth: `${now.getFullYear()}-01`,
    toMonth: `${now.getFullYear()}-12`,
    from: '',
    to: '',
    departmentId: '',
    supervisorId: '',
    employeeId: '',
    employmentStatus: '',
    paymentStatus: '',
    leaveStatus: '',
    attendanceStatus: '',
  })
  const [columnChoice, setColumnChoice] = useState<Record<string, string[]>>(loadColumnChoice)

  const catalogueQuery = useQuery({
    queryKey: ['reports', 'catalogue'],
    queryFn: () => get<ReportDescriptor[]>('/reports'),
  })

  const reports = catalogueQuery.data ?? []
  const report = reports.find((entry) => entry.key === selectedKey) ?? reports[0]

  useEffect(() => {
    if (!selectedKey && reports[0]) setSelectedKey(reports[0].key)
  }, [reports, selectedKey])

  // A report that takes more than one kind of period is run by one of them:
  // the period filters not chosen are neither shown nor sent.
  const [periodMode, setPeriodMode] = useState<PeriodMode>('month')
  const modes = PERIOD_MODES.filter((mode) => report?.filters.includes(PERIOD_KEYS[mode][1] as string))
  const modeList = modes.join(',')
  const activeMode = modes.includes(periodMode) ? periodMode : modes[0]
  const hasPeriodChoice = modes.length > 1
  const periodKeys = hasPeriodChoice && activeMode ? PERIOD_KEYS[activeMode] : []
  const hiddenKeys = useMemo(
    () =>
      hasPeriodChoice
        ? (modeList.split(',') as PeriodMode[]).filter((mode) => mode !== activeMode).flatMap((mode) => PERIOD_KEYS[mode])
        : [],
    [hasPeriodChoice, activeMode, modeList],
  )
  const accepts = (key: string): boolean => Boolean(report?.filters.includes(key)) && !hiddenKeys.includes(key)

  // Only send the filters this report actually accepts.
  const activeFilters = useMemo(() => {
    if (!report) return {}
    const result: Record<string, string | number> = {}
    for (const key of report.filters) {
      if (hiddenKeys.includes(key)) continue
      const value = filters[key]
      if (value) result[key] = value
    }
    return result
  }, [report, filters, hiddenKeys])

  const missingRequired = [...(report?.requiredFilters ?? []), ...periodKeys].filter((key) => !filters[key])
  const rangeBackwards =
    accepts('fromMonth') && Boolean(filters.fromMonth && filters.toMonth) && filters.toMonth! < filters.fromMonth!

  const dataQuery = useQuery({
    queryKey: ['reports', report?.key, activeFilters, page],
    queryFn: () => getWithMeta<Record<string, unknown>[]>(`/reports/${report?.key}`, { ...activeFilters, page, pageSize: 50 }),
    enabled: Boolean(report) && missingRequired.length === 0 && !rangeBackwards,
    placeholderData: keepPreviousData,
  })

  const rows = dataQuery.data?.data ?? []
  const meta = dataQuery.data?.meta
  // Every column the report has for this period; none is ever dropped from the choice.
  const allColumns = (meta?.columns as ReportColumn[] | undefined) ?? report?.columns ?? []
  // No choice, or a choice none of whose columns exist any more, shows every column.
  const chosenKeys = (report ? columnChoice[report.key] ?? [] : []).filter((key) =>
    allColumns.some((column) => column.key === key),
  )
  const columns = chosenKeys.length > 0 ? allColumns.filter((column) => chosenKeys.includes(column.key)) : allColumns
  const totals = (meta?.totals as Record<string, number> | undefined) ?? {}
  const grandTotals = (meta?.grandTotals as Record<string, number> | undefined) ?? {}
  const hasTotals = columns.some((column) => column.total) && Object.keys(grandTotals).length > 0
  // With a single page the page total is the grand total, so only one is shown.
  const isPaged = ((meta?.totalPages as number | undefined) ?? 1) > 1

  const setFilter = (key: string, value: string): void => {
    setFilters((current) => ({ ...current, [key]: value }))
    setPage(1)
  }

  const chooseColumns = (keys: string[]): void => {
    if (!report) return
    const next = { ...columnChoice, [report.key]: keys }
    if (keys.length === 0) delete next[report.key]
    setColumnChoice(next)
    saveColumnChoice(next)
  }

  // The chosen columns travel with every export and print.
  const exportQuery = { ...activeFilters, ...(chosenKeys.length > 0 ? { columns: chosenKeys.join(',') } : {}) }
  const cannotRun = missingRequired.length > 0 || rangeBackwards

  const runExport = async (format: 'csv' | 'xlsx' | 'pdf' | 'ecr'): Promise<void> => {
    if (!report) return
    setExporting(format)
    try {
      // The PF text file is named for its month; the others for the day they were run.
      const filename =
        format === 'ecr'
          ? `pf-ecr-${filters.year}-${String(filters.month).padStart(2, '0')}.txt`
          : `${report.key}-${todayIso()}.${format}`
      const headers = await download(`/reports/${report.key}/export`, filename, { ...exportQuery, format })
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

  const runPrint = async (): Promise<void> => {
    if (!report) return
    setExporting('print')
    try {
      printPdf(await fetchBlob(`/reports/${report.key}/export`, { ...exportQuery, format: 'pdf' }))
    } catch (error) {
      toast.error('Could not print the report', error instanceof Error ? error.message : undefined)
    } finally {
      setExporting(null)
    }
  }

  const renderCell = (value: unknown, format: ReportColumn['format']): string => {
    if (value === null || value === undefined || value === '') return '—'
    switch (format) {
      case 'currency':
        return formatCurrency(Number(value))
      case 'amount':
        // A column mixing kinds of figure: two decimals and no currency sign.
        return formatNumber(Number(value), 2)
      case 'days':
        return formatDays(Number(value))
      case 'number':
        // Whole numbers stay whole; a fraction such as 1.5 overtime hours keeps its decimals.
        return formatNumber(Number(value), Number.isInteger(Number(value)) ? 0 : 2)
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

  /** A month and year picked together, as "YYYY-MM". */
  const monthPicker = (key: 'fromMonth' | 'toMonth', label: string) => {
    const [year, month] = (filters[key] ?? '').split('-')
    const set = (nextYear: string, nextMonth: string): void => setFilter(key, `${nextYear}-${nextMonth.padStart(2, '0')}`)
    return (
      <Field label={label} htmlFor={`report-${key}`}>
        <div className="row" style={{ gap: '0.4rem', flexWrap: 'nowrap' }}>
          <Select
            id={`report-${key}`}
            aria-label={`${label}: month`}
            value={String(Number(month))}
            onChange={(event) => set(year ?? String(now.getFullYear()), event.target.value)}
          >
            {MONTH_NAMES.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </Select>
          <Select
            aria-label={`${label}: year`}
            value={year}
            onChange={(event) => set(event.target.value, month ?? '01')}
          >
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </div>
      </Field>
    )
  }

  /** The label "total" sits in the first column, unless that column has a total of its own to show. */
  const totalCell = (column: ReportColumn, index: number, label: string, values: Record<string, number>) =>
    index === 0 && !column.total ? label : column.total ? renderCell(values[column.key], column.format) : ''

  if (catalogueQuery.isLoading) return <Spinner label="Loading reports" />

  return (
    <div className="page">
      <PageHeader
        title="Reports"
        description="Every report can be filtered, its columns chosen, and exported to CSV, Excel or PDF or printed."
        actions={
          can('report.export') && report ? (
            <>
              <Button
                variant="secondary"
                icon={<Download size={15} />}
                loading={exporting === 'csv'}
                disabled={cannotRun}
                onClick={() => void runExport('csv')}
              >
                CSV
              </Button>
              <Button
                variant="secondary"
                icon={<FileSpreadsheet size={15} />}
                loading={exporting === 'xlsx'}
                disabled={cannotRun}
                onClick={() => void runExport('xlsx')}
              >
                Excel
              </Button>
              <Button
                variant="secondary"
                icon={<FileText size={15} />}
                loading={exporting === 'pdf'}
                disabled={cannotRun}
                onClick={() => void runExport('pdf')}
              >
                PDF
              </Button>
              <Button
                variant="secondary"
                icon={<Printer size={15} />}
                loading={exporting === 'print'}
                disabled={cannotRun}
                onClick={() => void runPrint()}
              >
                Print
              </Button>
              {report.key === 'pf-report' && activeMode !== 'monthRange' ? (
                <Button
                  variant="secondary"
                  icon={<FileType size={15} />}
                  loading={exporting === 'ecr'}
                  disabled={cannotRun}
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

          {hasPeriodChoice ? (
            <Field label="Period" htmlFor="report-period">
              <Select
                id="report-period"
                value={activeMode}
                onChange={(event) => {
                  setPeriodMode(event.target.value as PeriodMode)
                  setPage(1)
                }}
              >
                {modes.map((mode) => (
                  <option key={mode} value={mode}>
                    {PERIOD_LABELS[mode]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {accepts('year') ? (
            <Field label="Year" htmlFor="report-year">
              <Select id="report-year" value={filters.year} onChange={(event) => setFilter('year', event.target.value)}>
                {years.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {accepts('month') ? (
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

          {accepts('fromMonth') ? monthPicker('fromMonth', 'From month') : null}
          {accepts('toMonth') ? monthPicker('toMonth', 'To month') : null}

          {accepts('from') ? (
            <Field label="From" htmlFor="report-from">
              <Input id="report-from" type="date" value={filters.from} onChange={(event) => setFilter('from', event.target.value)} />
            </Field>
          ) : null}

          {accepts('to') ? (
            <Field label="To" htmlFor="report-to">
              <Input id="report-to" type="date" value={filters.to} onChange={(event) => setFilter('to', event.target.value)} />
            </Field>
          ) : null}

          {report?.filters.includes('departmentId') ? (
            <Field label="Department" htmlFor="report-department">
              <DepartmentMultiSelector
                id="report-department"
                value={filters.departmentId ? filters.departmentId.split(',') : []}
                onChange={(ids) => setFilter('departmentId', ids.join(','))}
              />
            </Field>
          ) : null}

          {report?.filters.includes('employeeId') ? (
            <Field label="Employee" htmlFor="report-employee">
              <EmployeeSelector
                id="report-employee"
                value={filters.employeeId ?? ''}
                onChange={(value) => setFilter('employeeId', value)}
                includeFormer
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

          {report ? (
            <Field label="Columns" htmlFor="report-columns">
              <MultiSelect
                id="report-columns"
                options={allColumns.map((column) => ({ value: column.key, label: column.label }))}
                value={chosenKeys}
                onChange={chooseColumns}
                allLabel="All columns"
                searchPlaceholder="Search columns"
              />
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
        ) : rangeBackwards ? (
          <div style={{ padding: '1.25rem' }}>
            <div className="alert alert-warning">The last month cannot be before the first.</div>
          </div>
        ) : dataQuery.error ? (
          <div style={{ padding: '1.25rem' }}>
            <div className="alert alert-warning">
              {dataQuery.error instanceof Error ? dataQuery.error.message : 'The report could not be run.'}
            </div>
          </div>
        ) : dataQuery.isFetching && rows.length === 0 ? (
          <Spinner label="Running the report" />
        ) : rows.length === 0 ? (
          <p className="muted" style={{ padding: '2.5rem', textAlign: 'center' }}>
            No rows match these filters.
          </p>
        ) : (
          <div className="data-table-wrapper report-table-wrapper">
            <table className="data-table report-table">
              <caption className="sr-only">{report?.name}</caption>
              {/* The header and the all-pages total stay pinned while the rows scroll. */}
              <thead>
                <tr className="report-header-row">
                  {columns.map((column) => (
                    <th key={column.key} className={isNumeric(column.format) ? 'align-right' : ''}>
                      {column.label}
                    </th>
                  ))}
                </tr>
                {hasTotals ? (
                  <tr className="report-grand-total">
                    {columns.map((column, index) => (
                      <td key={column.key} data-label={column.label} className={isNumeric(column.format) ? 'align-right' : ''}>
                        {totalCell(column, index, 'All pages total', grandTotals)}
                      </td>
                    ))}
                  </tr>
                ) : null}
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    {columns.map((column) => {
                      const value = row[column.key]
                      return (
                        <td key={column.key} data-label={column.label} className={isNumeric(column.format) ? 'align-right' : ''}>
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
              {isPaged && hasTotals ? (
                <tfoot>
                  <tr>
                    {columns.map((column, index) => (
                      <td key={column.key} data-label={column.label} className={isNumeric(column.format) ? 'align-right' : ''}>
                        {totalCell(column, index, 'Page total', totals)}
                      </td>
                    ))}
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
