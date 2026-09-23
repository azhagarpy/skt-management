import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, Plus, Trash2 } from 'lucide-react'
import { del, download, get, post, put } from '../../lib/api'
import { MONTH_NAMES, formatCurrency, formatDate } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Button, Card, ConfirmDialog, Field, Input, PageHeader, Select, Spinner, StatTile, Tabs } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { DepartmentSelector } from '../../components/forms/selectors'
import { MonthRangeFields, type MonthRange } from '../../components/forms/MonthRange'

/**
 * Panchayat Tax.
 *
 * Panchayat tax is set as bands of wages, each with the tax amount for a wage that
 * falls in it. The report applies the bands to each employee's total wages over a
 * period (a half-year for the usual filing), department by department. The tax can
 * then be deducted from salary in a payroll month of the administrator's choosing.
 */

interface TaxDeduction {
  id: string
  employeeId: string
  employeeCode: string | null
  employeeName: string | null
  departmentName: string | null
  payrollYear: number
  payrollMonth: number
  periodFrom: string
  periodTo: string
  wageBase: number
  taxAmount: number
}

interface Slab {
  upTo: number | null
  taxAmount: number
  label: string
}

interface ReportMonth {
  year: number
  month: number
  label: string
  runStatus: string | null
}

interface ReportGroup {
  departmentName: string
  rows: {
    employeeId: string
    employeeCode: string
    employeeName: string
    wages: number[]
    totalWages: number
    tax: number
  }[]
  totals: { wages: number[]; totalWages: number; tax: number }
}

interface TaxReport {
  months: ReportMonth[]
  slabs: Slab[]
  groups: ReportGroup[]
  totals: { employees: number; totalWages: number; tax: number }
}

/** "21000 Upto", "21001-30000", "75001- Above" - each band named by the wages it covers. */
function labelSlabs(rows: { upTo: string; taxAmount: string }[]): string[] {
  const number = (value: string): number => Number(value)
  return rows.map((row, index) => {
    const previous = rows[index - 1]
    const isLast = index === rows.length - 1
    const start = previous ? number(previous.upTo) + 1 : null
    if (isLast) return start === null ? 'All wages' : `${start}- Above`
    if (start === null) return row.upTo === '' ? '—' : `${number(row.upTo)} Upto`
    return `${start}-${row.upTo === '' ? '…' : number(row.upTo)}`
  })
}

/** The half-year (April-September or October-March) that most recently ended. */
function lastHalfYear(now: Date): MonthRange {
  const month = now.getMonth() + 1
  const year = now.getFullYear()
  if (month >= 10) return { fromYear: year, fromMonth: 4, toYear: year, toMonth: 9 }
  if (month >= 4) return { fromYear: year - 1, fromMonth: 10, toYear: year, toMonth: 3 }
  return { fromYear: year - 1, fromMonth: 4, toYear: year - 1, toMonth: 9 }
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default function TaxPage() {
  const { can } = useAuth()
  const [tab, setTab] = useState('report')

  return (
    <div className="page">
      <PageHeader
        title="Panchayat Tax"
        description="Set the Panchayat tax amount for each band of wages, and run the Panchayat tax report for a period."
      />

      <Tabs
        tabs={[
          { key: 'report', label: 'Panchayat tax report' },
          { key: 'deductions', label: 'Deducted from salary' },
          { key: 'slabs', label: 'Panchayat tax slabs' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'slabs' ? <SlabsTab canManage={can('tax.manage')} /> : null}
      {tab === 'deductions' ? <DeductionsTab canManage={can('tax.manage')} /> : null}
      {tab === 'report' ? <ReportTab canManage={can('tax.manage')} onDeducted={() => setTab('deductions')} /> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Slabs
// ---------------------------------------------------------------------------

interface SlabRow {
  upTo: string
  taxAmount: string
}

function SlabsTab({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['tax', 'slabs'],
    queryFn: () => get<Slab[]>('/tax/slabs'),
  })

  const saved = useMemo<SlabRow[]>(
    () => (data ?? []).map((slab) => ({ upTo: slab.upTo === null ? '' : String(slab.upTo), taxAmount: String(slab.taxAmount) })),
    [data],
  )
  const [rows, setRows] = useState<SlabRow[]>([])
  useEffect(() => setRows(saved), [saved])

  const labels = labelSlabs(rows)
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved)

  // The same rules the server enforces, so a mistake is caught before saving.
  const problems = useMemo(() => {
    const found: string[] = []
    if (rows.length === 0) found.push('Add at least one slab.')
    rows.forEach((row, index) => {
      const isLast = index === rows.length - 1
      if (!isLast && !(Number(row.upTo) > 0)) found.push(`Slab ${index + 1}: enter the wage limit.`)
      if (!isLast && index > 0 && Number(row.upTo) <= Number(rows[index - 1]?.upTo)) {
        found.push(`Slab ${index + 1}: the limit must be higher than the one before.`)
      }
      if (row.taxAmount === '' || Number(row.taxAmount) < 0) found.push(`Slab ${index + 1}: enter the tax amount (0 for none).`)
    })
    return found
  }, [rows])

  const save = useMutation({
    mutationFn: () =>
      put('/tax/slabs', {
        slabs: rows.map((row, index) => ({
          upTo: index === rows.length - 1 ? null : Number(row.upTo),
          taxAmount: Number(row.taxAmount),
        })),
      }),
    onSuccess: async (response) => {
      toast.success(response.message ?? 'Panchayat tax slabs saved')
      await queryClient.invalidateQueries({ queryKey: ['tax'] })
    },
    onError: (mutationError: Error) => toast.error('Could not save the slabs', mutationError.message),
  })

  const update = (index: number, patch: Partial<SlabRow>): void =>
    setRows((current) => current.map((row, position) => (position === index ? { ...row, ...patch } : row)))

  // A new band goes just before the open-ended one at the bottom.
  const addSlab = (): void =>
    setRows((current) => {
      const last = current[current.length - 1]
      const beforeLast = current.slice(0, -1)
      const previousLimit = Number(beforeLast[beforeLast.length - 1]?.upTo ?? 0)
      return [...beforeLast, { upTo: String(previousLimit + 15_000), taxAmount: '' }, ...(last ? [last] : [])]
    })

  if (isLoading) return <Spinner label="Loading tax slabs" />

  return (
    <Card
      title="Panchayat tax slabs"
      description="A person's Panchayat tax is the amount for the band their total wages over the report period fall in. The last band covers everything above the one before it."
      actions={
        canManage ? (
          <Button loading={save.isPending} disabled={!dirty || problems.length > 0} onClick={() => save.mutate()}>
            Save slabs
          </Button>
        ) : null
      }
    >
      {error ? <div className="alert alert-error">{error instanceof Error ? error.message : 'Could not load the slabs'}</div> : null}

      <div className="data-table-wrapper">
        <table className="data-table">
          <caption className="sr-only">Panchayat tax slabs</caption>
          <thead>
            <tr>
              <th>Wages</th>
              <th className="align-right">Up to (₹)</th>
              <th className="align-right">Tax (₹)</th>
              {canManage ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const isLast = index === rows.length - 1
              return (
                <tr key={index}>
                  <td data-label="Wages">
                    <strong>{labels[index]}</strong>
                  </td>
                  <td data-label="Up to" className="align-right">
                    {isLast ? (
                      <span className="subtle">and above</span>
                    ) : (
                      <Input
                        aria-label={`Slab ${index + 1} upper limit`}
                        type="number"
                        min="1"
                        step="1"
                        value={row.upTo}
                        disabled={!canManage}
                        style={{ maxWidth: 140, marginLeft: 'auto' }}
                        onChange={(event) => update(index, { upTo: event.target.value })}
                      />
                    )}
                  </td>
                  <td data-label="Tax" className="align-right">
                    <Input
                      aria-label={`Slab ${index + 1} tax amount`}
                      type="number"
                      min="0"
                      step="1"
                      value={row.taxAmount}
                      disabled={!canManage}
                      style={{ maxWidth: 120, marginLeft: 'auto' }}
                      onChange={(event) => update(index, { taxAmount: event.target.value })}
                    />
                  </td>
                  {canManage ? (
                    <td className="align-right">
                      {!isLast && rows.length > 1 ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Trash2 size={13} />}
                          onClick={() => setRows((current) => current.filter((_, position) => position !== index))}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {canManage ? (
        <div style={{ paddingTop: '0.75rem' }}>
          <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={addSlab} disabled={rows.length === 0}>
            Add a slab
          </Button>
        </div>
      ) : null}

      {dirty && problems.length > 0 ? (
        <ul className="field-message field-message-error" style={{ marginTop: '0.75rem' }}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Deducted from salary
// ---------------------------------------------------------------------------

function DeductionsTab({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState<number | ''>('')
  const [removing, setRemoving] = useState<TaxDeduction | null>(null)

  const params = { payrollYear: year, payrollMonth: month === '' ? undefined : month }
  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['tax', 'deductions', params],
    queryFn: () => get<TaxDeduction[]>('/tax/deductions', params),
  })

  const remove = useMutation({
    mutationFn: (entry: TaxDeduction) => del(`/tax/deductions/${entry.id}`),
    onSuccess: async () => {
      toast.success('Panchayat tax deduction removed')
      setRemoving(null)
      await queryClient.invalidateQueries({ queryKey: ['tax', 'deductions'] })
    },
    onError: (mutationError: Error) => {
      setRemoving(null)
      toast.error('Could not remove it', mutationError.message)
    },
  })

  const rows = data ?? []
  const total = rows.reduce((sum, row) => sum + row.taxAmount, 0)
  const years = Array.from({ length: 5 }, (_, index) => now.getFullYear() + 1 - index)

  const columns: Column<TaxDeduction>[] = [
    {
      key: 'employee',
      header: 'Employee',
      render: (row) => (
        <div>
          <strong>{row.employeeName ?? '—'}</strong>
          <p className="subtle">{row.employeeCode}</p>
        </div>
      ),
    },
    { key: 'department', header: 'Department', hideOnMobile: true, render: (row) => row.departmentName ?? '—' },
    {
      key: 'period',
      header: 'Wages for',
      hideOnMobile: true,
      render: (row) => `${formatDate(row.periodFrom)} – ${formatDate(row.periodTo)}`,
    },
    { key: 'wages', header: 'Total wages', align: 'right', render: (row) => formatCurrency(row.wageBase) },
    { key: 'tax', header: 'Tax', align: 'right', render: (row) => <strong>{formatCurrency(row.taxAmount)}</strong> },
    { key: 'month', header: 'Deducted in', render: (row) => `${MONTH_NAMES[row.payrollMonth - 1]} ${row.payrollYear}` },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            render: (row: TaxDeduction) => (
              <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setRemoving(row)}>
                Remove
              </Button>
            ),
          },
        ]
      : []),
  ]

  return (
    <div className="stack">
      <div className="grid grid-3">
        <StatTile label="Employees" value={rows.length} tone="info" />
        <StatTile label="Panchayat tax to be deducted" value={formatCurrency(total)} tone="success" />
      </div>

      <Card
        title="Deducted from salary"
        description="Panchayat tax set to come out of pay, by payroll month. Payroll deducts it as P.Tax when it calculates that month."
        padded={false}
      >
        <div className="filter-bar">
          <Field label="Year" htmlFor="tax-ded-year">
            <Select id="tax-ded-year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Month" htmlFor="tax-ded-month">
            <Select
              id="tax-ded-month"
              value={month}
              onChange={(event) => setMonth(event.target.value === '' ? '' : Number(event.target.value))}
            >
              <option value="">All months</option>
              {MONTH_NAMES.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
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
          emptyTitle="No Panchayat tax is set to be deducted"
          emptyDescription="Run the Panchayat tax report and use Deduct from salary to choose the payroll month."
          caption="Panchayat tax deducted from salary"
        />
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title="Remove Panchayat tax deduction"
        message={`Stop deducting ${removing ? formatCurrency(removing.taxAmount) : ''} of tax from ${removing?.employeeName} in ${removing ? MONTH_NAMES[removing.payrollMonth - 1] : ''} ${removing?.payrollYear ?? ''}?`}
        confirmLabel="Remove"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
        onCancel={() => setRemoving(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function ReportTab({ canManage, onDeducted }: { canManage: boolean; onDeducted: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const now = new Date()
  const years = Array.from({ length: 6 }, (_, index) => now.getFullYear() - index)

  const [period, setPeriod] = useState<MonthRange>(() => lastHalfYear(now))
  const [departmentId, setDepartmentId] = useState('')
  const [exporting, setExporting] = useState(false)
  // The month the tax comes out of pay: by default the month after the period ends.
  const [payroll, setPayroll] = useState<{ year: number; month: number }>(() => {
    const end = lastHalfYear(now)
    return end.toMonth === 12 ? { year: end.toYear + 1, month: 1 } : { year: end.toYear, month: end.toMonth + 1 }
  })
  const [confirming, setConfirming] = useState(false)

  const length = (period.toYear * 12 + period.toMonth) - (period.fromYear * 12 + period.fromMonth) + 1
  const valid = length >= 1 && length <= 12

  const params = { ...period, departmentId: departmentId || undefined }

  const { data, isFetching, error } = useQuery({
    queryKey: ['tax', 'report', params],
    queryFn: () => get<TaxReport>('/tax/report', params),
    enabled: valid,
  })

  // Quick picks for the two half-years of each recent year.
  const halfYears = useMemo(() => {
    const options: { key: string; label: string; range: MonthRange }[] = []
    for (let year = now.getFullYear(); year >= now.getFullYear() - 2; year -= 1) {
      options.push({
        key: `${year}-H2`,
        label: `Oct ${year} – Mar ${year + 1}`,
        range: { fromYear: year, fromMonth: 10, toYear: year + 1, toMonth: 3 },
      })
      options.push({
        key: `${year}-H1`,
        label: `Apr ${year} – Sep ${year}`,
        range: { fromYear: year, fromMonth: 4, toYear: year, toMonth: 9 },
      })
    }
    return options
  }, [])
  const activeHalf = halfYears.find(
    (option) =>
      option.range.fromYear === period.fromYear &&
      option.range.fromMonth === period.fromMonth &&
      option.range.toYear === period.toYear &&
      option.range.toMonth === period.toMonth,
  )

  const deduct = useMutation({
    mutationFn: () => post('/tax/deductions', { ...params, payrollYear: payroll.year, payrollMonth: payroll.month }),
    onSuccess: async (response) => {
      setConfirming(false)
      toast.success(response.message ?? 'Panchayat tax set to be deducted')
      await queryClient.invalidateQueries({ queryKey: ['tax', 'deductions'] })
      onDeducted()
    },
    onError: (mutationError: Error) => {
      setConfirming(false)
      toast.error('Could not set the deduction', mutationError.message)
    },
  })

  const runExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const pad = (value: number): string => String(value).padStart(2, '0')
      await download(
        '/tax/report/export',
        `ptax-${period.fromYear}-${pad(period.fromMonth)}-to-${period.toYear}-${pad(period.toMonth)}.xlsx`,
        params,
      )
    } catch (exportError) {
      toast.error('Export failed', exportError instanceof Error ? exportError.message : undefined)
    } finally {
      setExporting(false)
    }
  }

  const months = data?.months ?? []
  const groups = data?.groups ?? []
  const missing = months.filter((entry) => entry.runStatus === null)
  const unapproved = months.filter((entry) => entry.runStatus !== null && !['APPROVED', 'LOCKED'].includes(entry.runStatus))

  return (
    <div className="stack">
      <Card
        title="Panchayat tax report"
        description="Each employee's monthly wages, their total over the period, and the Panchayat tax that total falls under. Wages are salary earnings only, without bonuses, overtime or adjustments."
        actions={
          can('report.export') ? (
            <Button
              variant="secondary"
              icon={<FileSpreadsheet size={15} />}
              loading={exporting}
              disabled={!valid || groups.length === 0}
              onClick={() => void runExport()}
            >
              Excel
            </Button>
          ) : null
        }
      >
        <div className="stack">
          <div className="grid grid-2">
            <Field label="Half-year" htmlFor="tax-half-year">
              <Select
                id="tax-half-year"
                value={activeHalf?.key ?? ''}
                onChange={(event) => {
                  const chosen = halfYears.find((option) => option.key === event.target.value)
                  if (chosen) setPeriod(chosen.range)
                }}
              >
                {activeHalf ? null : <option value="">Custom period</option>}
                {halfYears.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Department" htmlFor="tax-department" hint="Leave on all to get a sheet for every department.">
              <DepartmentSelector id="tax-department" value={departmentId} onChange={setDepartmentId} />
            </Field>
          </div>
          <MonthRangeFields
            idPrefix="tax-period"
            years={years}
            value={period}
            onChange={(next) => setPeriod({ ...period, ...next })}
            hint={length > 12 ? 'Choose a period of 12 months or fewer.' : length < 1 ? 'The end month is before the start month.' : undefined}
          />
        </div>
      </Card>

      {canManage ? (
        <Card
          title="Deduct from salary"
          description="Choose the payroll month this tax comes out of pay. It appears on the payslip as P.Tax when that month's payroll is calculated."
        >
          <div className="row" style={{ gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Payroll month" htmlFor="tax-payroll-month">
              <Select
                id="tax-payroll-month"
                value={payroll.month}
                onChange={(event) => setPayroll({ ...payroll, month: Number(event.target.value) })}
              >
                {MONTH_NAMES.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payroll year" htmlFor="tax-payroll-year">
              <Select
                id="tax-payroll-year"
                value={payroll.year}
                onChange={(event) => setPayroll({ ...payroll, year: Number(event.target.value) })}
              >
                {Array.from(new Set([...years, now.getFullYear() + 1, payroll.year])).sort((a, b) => b - a).map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              disabled={!valid || (data?.totals.tax ?? 0) <= 0}
              loading={deduct.isPending}
              onClick={() => setConfirming(true)}
            >
              Deduct in {MONTH_NAMES[payroll.month - 1]} {payroll.year}
            </Button>
          </div>
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title="Deduct Panchayat tax from salary"
        message={`Deduct ${formatCurrency(data?.totals.tax ?? 0)} of Panchayat tax from ${
          groups.reduce((sum, group) => sum + group.rows.filter((row) => row.tax > 0).length, 0)
        } employees in the ${MONTH_NAMES[payroll.month - 1]} ${payroll.year} payroll? Doing this again for the same month replaces what was set, until that payroll is approved.`}
        confirmLabel="Deduct tax"
        loading={deduct.isPending}
        onConfirm={() => deduct.mutate()}
        onCancel={() => setConfirming(false)}
      />

      {missing.length > 0 ? (
        <div className="alert alert-warning">
          No payroll has been run for {missing.map((entry) => entry.label).join(', ')}, so those months count as zero.
        </div>
      ) : null}
      {unapproved.length > 0 ? (
        <div className="alert alert-info">
          Payroll for {unapproved.map((entry) => entry.label).join(', ')} is not approved yet, so these figures may still change.
        </div>
      ) : null}
      {data && data.slabs.length === 0 ? (
        <div className="alert alert-warning">
          No Panchayat tax slabs are set, so every tax amount is zero. Add them on the Panchayat tax slabs tab.
        </div>
      ) : null}

      {isFetching && groups.length === 0 ? (
        <Spinner label="Running the tax report" />
      ) : error ? (
        <div className="alert alert-error">{error instanceof Error ? error.message : 'Could not run the report'}</div>
      ) : (
        <>
          <div className="grid grid-3">
            <StatTile label="Employees" value={data?.totals.employees ?? 0} tone="info" />
            <StatTile label="Total wages" value={formatCurrency(data?.totals.totalWages ?? 0)} tone="accent" />
            <StatTile label="Panchayat tax" value={formatCurrency(data?.totals.tax ?? 0)} tone="success" />
          </div>

          {groups.length === 0 ? (
            <Card>
              <p className="muted" style={{ textAlign: 'center' }}>
                No payroll found for these months.
              </p>
            </Card>
          ) : (
            groups.map((group) => (
              <Card
                key={group.departmentName}
                title={group.departmentName}
                description={`${group.rows.length} employee${group.rows.length === 1 ? '' : 's'} · tax ${formatCurrency(group.totals.tax)}`}
                padded={false}
              >
                <div className="data-table-wrapper">
                  <table className="data-table">
                    <caption className="sr-only">{group.departmentName} tax</caption>
                    <thead>
                      <tr>
                        <th>Sr.No</th>
                        <th>Emp ID</th>
                        <th>Emp Name</th>
                        {months.map((entry) => (
                          <th key={entry.label} className="align-right">
                            {SHORT_MONTHS[entry.month - 1]}-{String(entry.year).slice(-2)}
                          </th>
                        ))}
                        <th className="align-right">Total wages</th>
                        <th className="align-right">P.Tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row, index) => (
                        <tr key={row.employeeId}>
                          <td data-label="Sr.No">{index + 1}</td>
                          <td data-label="Emp ID">{row.employeeCode}</td>
                          <td data-label="Emp Name">{row.employeeName}</td>
                          {row.wages.map((amount, position) => (
                            <td key={months[position]?.label ?? position} data-label={months[position]?.label} className="align-right">
                              {amount === 0 ? '—' : formatCurrency(amount)}
                            </td>
                          ))}
                          <td data-label="Total wages" className="align-right">{formatCurrency(row.totalWages)}</td>
                          <td data-label="P.Tax" className="align-right">
                            <strong>{formatCurrency(row.tax)}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3}>Total</td>
                        {group.totals.wages.map((amount, position) => (
                          <td key={months[position]?.label ?? position} className="align-right">
                            {formatCurrency(amount)}
                          </td>
                        ))}
                        <td className="align-right">{formatCurrency(group.totals.totalWages)}</td>
                        <td className="align-right">{formatCurrency(group.totals.tax)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Card>
            ))
          )}
        </>
      )}
    </div>
  )
}
