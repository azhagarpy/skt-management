import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, FileSpreadsheet, Plus, Trash2, Wallet } from 'lucide-react'
import { del, download, get, getWithMeta, patch, post } from '../../lib/api'
import { MONTH_NAMES, formatCurrency, formatDate, formatDays, todayIso } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  StatTile,
  StatusBadge,
  Tabs,
  Textarea,
} from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { DepartmentMultiSelector, DepartmentSelector, idsParam, useDepartments } from '../../components/forms/selectors'
import { MonthRangeFields, type MonthRange } from '../../components/forms/MonthRange'
import { MarkPaidModal, PayoutSummary } from '../../components/forms/Payout'
import type { Bonus, EmployeeSummary } from '../../types/api'

/**
 * Bonuses (plan section 25).
 *
 * A bonus is a name and an amount given to some employees: pick them one by one,
 * or give it to everyone in a department. The amount is fixed, or a percentage of
 * the wages earned over a month range (worked out on the Bonus statement tab).
 * It is paid separately from salary: once an approved bonus has been paid, it is
 * marked paid with the date, how it was paid and a supporting document - one at
 * a time, or many at once with one document.
 */

type Audience = 'EMPLOYEES' | 'DEPARTMENT'
type Calculation = 'FIXED' | 'PERCENT_OF_WAGES'

interface StatementMonth {
  year: number
  month: number
  label: string
  runStatus: string | null
}

interface StatementRow {
  employeeId: string
  employeeCode: string
  employeeName: string
  departmentName: string | null
  sectionName: string | null
  months: { manDays: number; wages: number }[]
  totalManDays: number
  totalWages: number
  eligible: boolean
  bonus: number
}

interface Statement {
  months: StatementMonth[]
  rows: StatementRow[]
  summary: { departmentName: string; employees: number; manDays: number; bonus: number }[]
  totals: { employees: number; manDays: number; wages: number; bonus: number }
}

/** The financial year (April to March) that most recently ended - the usual bonus year. */
function lastFinancialYear(now: Date): { fromYear: number; toYear: number } {
  const startYear = now.getMonth() + 1 >= 4 ? now.getFullYear() - 1 : now.getFullYear() - 2
  return { fromYear: startYear, toYear: startYear + 1 }
}

const monthsInRange = (fromYear: number, fromMonth: number, toYear: number, toMonth: number): number =>
  (toYear * 12 + toMonth) - (fromYear * 12 + fromMonth) + 1

export default function BonusesPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can } = useAuth()

  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState<number | ''>('')
  const [status, setStatus] = useState('')
  const [departmentFilter, setDepartmentFilter] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [tab, setTab] = useState('bonuses')
  const [deleteTarget, setDeleteTarget] = useState<Bonus | null>(null)
  const [unpaidTarget, setUnpaidTarget] = useState<Bonus | null>(null)
  // The bonuses the payment dialog is open for, and the one being corrected, if any.
  const [paying, setPaying] = useState<{ ids: string[]; row: Bonus | null } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const canManage = can('bonus.manage')

  const filters = {
    payrollYear: year,
    payrollMonth: month === '' ? undefined : month,
    status: status || undefined,
    departmentId: idsParam(departmentFilter),
  }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['bonuses', filters],
    queryFn: () => get<Bonus[]>('/bonuses', filters),
  })

  const deleteMutation = useMutation({
    mutationFn: (bonus: Bonus) => del(`/bonuses/${bonus.id}`),
    onSuccess: async () => {
      toast.success('Bonus removed')
      setDeleteTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['bonuses'] })
    },
    onError: (mutationError: Error) => {
      setDeleteTarget(null)
      toast.error('Could not remove the bonus', mutationError.message)
    },
  })

  const approveMutation = useMutation({
    mutationFn: (bonus: Bonus) => patch(`/bonuses/${bonus.id}`, { status: 'APPROVED' }),
    onSuccess: async () => {
      toast.success('Bonus approved')
      await queryClient.invalidateQueries({ queryKey: ['bonuses'] })
    },
    onError: (mutationError: Error) => toast.error('Could not approve the bonus', mutationError.message),
  })

  const unpaidMutation = useMutation({
    mutationFn: (bonus: Bonus) => patch(`/bonuses/${bonus.id}/mark-unpaid`),
    onSuccess: async () => {
      toast.success('Marked as not paid')
      setUnpaidTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['bonuses'] })
    },
    onError: (mutationError: Error) => {
      setUnpaidTarget(null)
      toast.error('Could not mark as not paid', mutationError.message)
    },
  })

  const rows = data ?? []
  const live = rows.filter((row) => row.status !== 'CANCELLED')
  const sum = (list: Bonus[]): number => list.reduce((value, row) => value + row.amount, 0)
  const paidRows = rows.filter((row) => row.status === 'PAID')
  const unpaidRows = rows.filter((row) => row.status === 'APPROVED')

  // Only approved, unpaid bonuses can be paid together; anything selected that
  // is no longer shown or no longer unpaid drops out.
  const selectedRows = unpaidRows.filter((row) => selected.has(row.id))
  const allUnpaidSelected = unpaidRows.length > 0 && selectedRows.length === unpaidRows.length
  const toggle = (id: string, checked: boolean): void => {
    const next = new Set(selected)
    if (checked) next.add(id)
    else next.delete(id)
    setSelected(next)
  }

  const columns: Column<Bonus>[] = [
    ...(canManage
      ? [
          {
            key: 'select',
            header: '',
            render: (row: Bonus) =>
              row.status === 'APPROVED' ? (
                <input
                  type="checkbox"
                  aria-label={`Select the bonus for ${row.employeeName ?? row.employeeCode ?? ''}`}
                  checked={selected.has(row.id)}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => toggle(row.id, event.target.checked)}
                />
              ) : null,
          },
        ]
      : []),
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
    { key: 'name', header: 'Bonus', render: (row) => row.bonusName },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (row) => (
        <div>
          {formatCurrency(row.amount)}
          {row.wagePercentage !== null && row.wageBase !== null ? (
            <p className="subtle">
              {row.wagePercentage}% of {formatCurrency(row.wageBase)}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'period',
      header: 'Month',
      render: (row) => `${MONTH_NAMES[row.payrollMonth - 1]} ${row.payrollYear}`,
    },
    { key: 'date', header: 'Bonus date', hideOnMobile: true, render: (row) => formatDate(row.bonusDate) },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div>
          {row.status === 'APPROVED' ? <Badge tone="warning">Not paid</Badge> : <StatusBadge status={row.status} />}
          {row.status === 'PAID' ? (
            <PayoutSummary payout={row} proofPath={`/bonuses/${row.id}/proof`} proofName={`bonus-${row.employeeCode ?? row.id}`} />
          ) : null}
        </div>
      ),
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            render: (row: Bonus) => (
              <div className="row" style={{ gap: '0.35rem', justifyContent: 'flex-end' }}>
                {row.status === 'PENDING' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<BadgeCheck size={13} />}
                    loading={approveMutation.isPending && approveMutation.variables?.id === row.id}
                    onClick={() => approveMutation.mutate(row)}
                  >
                    Approve
                  </Button>
                ) : null}
                {row.status === 'APPROVED' ? (
                  <Button size="sm" variant="secondary" icon={<Wallet size={13} />} onClick={() => setPaying({ ids: [row.id], row: null })}>
                    Mark paid
                  </Button>
                ) : null}
                {row.status === 'PAID' ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setPaying({ ids: [row.id], row })}>
                      Edit payment
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setUnpaidTarget(row)}>
                      Mark not paid
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDeleteTarget(row)}>
                    Remove
                  </Button>
                )}
              </div>
            ),
          },
        ]
      : []),
  ]

  const payingRows = paying ? rows.filter((row) => paying.ids.includes(row.id)) : []

  const years = Array.from({ length: 5 }, (_, index) => now.getFullYear() - index)

  return (
    <div className="page">
      <PageHeader
        title="Bonuses"
        description="Bonuses are paid separately from salary. Once a bonus has been paid, mark it paid with the date, how it was paid and a supporting document."
        actions={
          canManage ? (
            <Button icon={<Plus size={15} />} onClick={() => setAdding(true)}>
              Add bonus
            </Button>
          ) : null
        }
      />

      <Tabs
        tabs={[
          { key: 'bonuses', label: 'Bonuses' },
          { key: 'statement', label: 'Bonus statement' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'statement' ? <BonusStatementTab years={years} /> : null}

      {tab === 'bonuses' ? (
        <>
      <div className="grid grid-4">
        <StatTile
          label="Total value"
          value={formatCurrency(sum(live))}
          sublabel={`${live.length} bonus${live.length === 1 ? '' : 'es'} · ${month === '' ? year : `${MONTH_NAMES[Number(month) - 1]} ${year}`}`}
          tone="accent"
        />
        <StatTile label="Paid" value={formatCurrency(sum(paidRows))} sublabel={`${paidRows.length} paid`} tone="success" />
        <StatTile label="Not paid yet" value={formatCurrency(sum(unpaidRows))} sublabel={`${unpaidRows.length} approved, waiting to be paid`} tone="warning" />
        <StatTile label="Pending approval" value={rows.filter((row) => row.status === 'PENDING').length} tone="info" />
      </div>

      <Card padded={false}>
        <div className="filter-bar">
          <Field label="Year" htmlFor="bonus-year">
            <Select id="bonus-year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Month" htmlFor="bonus-month">
            <Select
              id="bonus-month"
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

          <Field label="Department" htmlFor="bonus-department-filter">
            <DepartmentMultiSelector id="bonus-department-filter" value={departmentFilter} onChange={setDepartmentFilter} />
          </Field>

          <Field label="Status" htmlFor="bonus-status">
            <Select id="bonus-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="PENDING">Pending approval</option>
              <option value="APPROVED">Not paid</option>
              <option value="PAID">Paid</option>
              <option value="CANCELLED">Cancelled</option>
            </Select>
          </Field>
        </div>

        {canManage && unpaidRows.length > 0 ? (
          <div className="row" style={{ gap: '0.5rem', padding: '0 1rem 0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSelected(allUnpaidSelected ? new Set() : new Set(unpaidRows.map((row) => row.id)))}
            >
              {allUnpaidSelected ? 'Clear selection' : `Select all not paid (${unpaidRows.length})`}
            </Button>
            {selectedRows.length > 0 ? (
              <Button size="sm" icon={<Wallet size={13} />} onClick={() => setPaying({ ids: selectedRows.map((row) => row.id), row: null })}>
                Mark {selectedRows.length} paid · {formatCurrency(sum(selectedRows))}
              </Button>
            ) : null}
          </div>
        ) : null}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          emptyTitle="No bonuses for this period"
          caption="Bonuses"
        />
      </Card>
        </>
      ) : null}

      <AddBonusModal open={adding} years={years} onClose={() => setAdding(false)} />

      <MarkPaidModal
        open={paying !== null}
        title={paying?.row ? 'Edit payment' : 'Mark as paid'}
        description={
          paying?.row
            ? `How the ${formatCurrency(paying.row.amount)} bonus for ${paying.row.employeeName ?? paying.row.employeeCode} was paid.`
            : payingRows.length > 1
              ? `Record that these ${payingRows.length} bonuses, ${formatCurrency(sum(payingRows))} in all, have been paid.`
              : `Record that the ${formatCurrency(sum(payingRows))} bonus for ${payingRows[0]?.employeeName ?? 'this employee'} has been paid.`
        }
        basePath="/bonuses"
        ids={paying?.ids ?? []}
        initial={paying?.row ?? null}
        queryKey="bonuses"
        onClose={() => setPaying(null)}
        onDone={() => setSelected(new Set())}
      />

      <ConfirmDialog
        open={unpaidTarget !== null}
        title="Mark as not paid"
        message={`Mark the ${unpaidTarget ? formatCurrency(unpaidTarget.amount) : ''} bonus for ${unpaidTarget?.employeeName ?? ''} as not paid? Its payment details and supporting document are removed.`}
        confirmLabel="Mark not paid"
        tone="danger"
        loading={unpaidMutation.isPending}
        onConfirm={() => unpaidTarget && unpaidMutation.mutate(unpaidTarget)}
        onCancel={() => setUnpaidTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove bonus"
        message={`Remove the ${deleteTarget ? formatCurrency(deleteTarget.amount) : ''} bonus for ${deleteTarget?.employeeName}?`}
        confirmLabel="Remove"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add bonus
// ---------------------------------------------------------------------------

function AddBonusModal({ open, years, onClose }: { open: boolean; years: number[]; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const now = new Date()

  const range = lastFinancialYear(now)
  const emptyForm = {
    bonusName: '',
    calculation: 'FIXED' as Calculation,
    amount: '',
    percentage: '8.33',
    fromYear: range.fromYear,
    fromMonth: 4,
    toYear: range.toYear,
    toMonth: 3,
    minManDays: '30',
    payrollYear: now.getFullYear(),
    payrollMonth: now.getMonth() + 1,
    reason: '',
    status: 'APPROVED',
  }
  const [form, setForm] = useState(emptyForm)
  const [audience, setAudience] = useState<Audience>('EMPLOYEES')
  const [departmentId, setDepartmentId] = useState('')
  const [selected, setSelected] = useState<Map<string, EmployeeSummary>>(new Map())

  const { data: departments } = useDepartments()

  // How many people a department bonus will reach, so the count is never a surprise.
  const { data: departmentHeadcount } = useQuery({
    queryKey: ['employees', 'department-headcount', departmentId],
    queryFn: () =>
      getWithMeta<EmployeeSummary[]>('/employees', { departmentId, employmentStatus: 'ACTIVE', pageSize: 1 }),
    enabled: open && audience === 'DEPARTMENT' && Boolean(departmentId),
  })
  const departmentCount = (departmentHeadcount?.meta?.total as number | undefined) ?? null
  const departmentName = departments?.find((department) => department.id === departmentId)?.name

  const recipientCount = audience === 'DEPARTMENT' ? (departmentCount ?? 0) : selected.size
  const hasRecipients = audience === 'DEPARTMENT' ? Boolean(departmentId) && (departmentCount ?? 1) > 0 : selected.size > 0

  const close = (): void => {
    setForm(emptyForm)
    setAudience('EMPLOYEES')
    setDepartmentId('')
    setSelected(new Map())
    onClose()
  }

  const createMutation = useMutation({
    mutationFn: () =>
      post('/bonuses', {
        bonusName: form.bonusName.trim(),
        calculation: form.calculation,
        ...(form.calculation === 'FIXED'
          ? { amount: Number(form.amount) }
          : {
              percentage: Number(form.percentage),
              fromYear: form.fromYear,
              fromMonth: form.fromMonth,
              toYear: form.toYear,
              toMonth: form.toMonth,
              minManDays: Number(form.minManDays) || 0,
            }),
        bonusDate: todayIso(),
        payrollYear: form.payrollYear,
        payrollMonth: form.payrollMonth,
        reason: form.reason.trim() || null,
        status: form.status,
        ...(audience === 'DEPARTMENT' ? { departmentId } : { employeeIds: [...selected.keys()] }),
      }),
    onSuccess: async (response) => {
      toast.success(response.message ?? 'Bonus added')
      await queryClient.invalidateQueries({ queryKey: ['bonuses'] })
      close()
    },
    onError: (mutationError: Error) => toast.error('Could not add the bonus', mutationError.message),
  })

  const rangeLength = monthsInRange(form.fromYear, form.fromMonth, form.toYear, form.toMonth)
  const amountReady =
    form.calculation === 'FIXED'
      ? Number(form.amount) > 0
      : Number(form.percentage) > 0 && Number(form.percentage) <= 100 && rangeLength >= 1 && rangeLength <= 24
  const canSubmit = form.bonusName.trim().length >= 2 && amountReady && hasRecipients

  return (
    <Modal
      open={open}
      title="Add bonus"
      description="A bonus is paid separately from salary. Once it has been paid, mark it paid on this page."
      onClose={close}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button loading={createMutation.isPending} disabled={!canSubmit} onClick={() => createMutation.mutate()}>
            {recipientCount > 1 ? `Add bonus for up to ${recipientCount} employees` : 'Add bonus'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Bonus name" htmlFor="bonus-name" required>
            <Input
              id="bonus-name"
              value={form.bonusName}
              placeholder="e.g. Diwali bonus"
              maxLength={120}
              onChange={(event) => setForm({ ...form, bonusName: event.target.value })}
            />
          </Field>
          <Field label="How is the amount decided?" htmlFor="bonus-calculation" required>
            <Select
              id="bonus-calculation"
              value={form.calculation}
              onChange={(event) => setForm({ ...form, calculation: event.target.value as Calculation })}
            >
              <option value="FIXED">A fixed amount for everyone</option>
              <option value="PERCENT_OF_WAGES">A percentage of wages over a month range</option>
            </Select>
          </Field>
        </div>

        {form.calculation === 'FIXED' ? (
          <Field label="Amount (each)" htmlFor="bonus-amount" required>
            <Input
              id="bonus-amount"
              type="number"
              step="0.01"
              min="0.01"
              value={form.amount}
              onChange={(event) => setForm({ ...form, amount: event.target.value })}
            />
          </Field>
        ) : (
          <div className="stack">
            <div className="grid grid-2">
              <Field label="Percentage of total wages" htmlFor="bonus-percentage" required>
                <Input
                  id="bonus-percentage"
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="100"
                  value={form.percentage}
                  onChange={(event) => setForm({ ...form, percentage: event.target.value })}
                />
              </Field>
              <Field
                label="Minimum man days"
                htmlFor="bonus-min-days"
                hint="Anyone who worked fewer days over the range gets no bonus. 0 means no minimum."
              >
                <Input
                  id="bonus-min-days"
                  type="number"
                  step="0.5"
                  min="0"
                  value={form.minManDays}
                  onChange={(event) => setForm({ ...form, minManDays: event.target.value })}
                />
              </Field>
            </div>
            <MonthRangeFields
              idPrefix="bonus-range"
              years={years}
              value={form}
              onChange={(next) => setForm({ ...form, ...next })}
              hint={
                rangeLength > 24
                  ? 'Choose a range of 24 months or fewer.'
                  : rangeLength < 1
                    ? 'The end month is before the start month.'
                    : 'Wages are taken from payroll for these months. Check them on the Bonus statement tab first.'
              }
            />
          </div>
        )}

        <div className="grid grid-2">
          <Field label="Month" htmlFor="bonus-payroll-month" required>
            <Select
              id="bonus-payroll-month"
              value={form.payrollMonth}
              onChange={(event) => setForm({ ...form, payrollMonth: Number(event.target.value) })}
            >
              {MONTH_NAMES.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Year" htmlFor="bonus-payroll-year" required>
            <Select
              id="bonus-payroll-year"
              value={form.payrollYear}
              onChange={(event) => setForm({ ...form, payrollYear: Number(event.target.value) })}
            >
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Give this bonus to</legend>
          <div className="row" style={{ gap: '1.25rem', marginTop: '0.4rem' }}>
            <label className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
              <input type="radio" name="bonus-audience" checked={audience === 'EMPLOYEES'} onChange={() => setAudience('EMPLOYEES')} />
              <span>Selected employees</span>
            </label>
            <label className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
              <input type="radio" name="bonus-audience" checked={audience === 'DEPARTMENT'} onChange={() => setAudience('DEPARTMENT')} />
              <span>Everyone in a department</span>
            </label>
          </div>
        </fieldset>

        {audience === 'DEPARTMENT' ? (
          <Field
            label="Department"
            htmlFor="bonus-department"
            required
            hint={
              departmentId && departmentCount !== null
                ? departmentCount === 0
                  ? `No active employees in ${departmentName ?? 'this department'}.`
                  : `${departmentCount} active employee${departmentCount === 1 ? '' : 's'} in ${departmentName ?? 'this department'} will each get this bonus.`
                : 'Every active employee in the department gets the bonus.'
            }
          >
            <DepartmentSelector id="bonus-department" value={departmentId} onChange={setDepartmentId} includeAll={false} />
          </Field>
        ) : (
          <EmployeePicker selected={selected} onChange={setSelected} />
        )}

        <div className="grid grid-2">
          <Field label="Status" htmlFor="bonus-form-status">
            <Select id="bonus-form-status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
              <option value="APPROVED">Approved (ready to pay)</option>
              <option value="PENDING">Pending approval</option>
            </Select>
          </Field>
        </div>

        <Field label="Reason" htmlFor="bonus-reason">
          <Textarea id="bonus-reason" rows={2} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

/**
 * A searchable checklist of employees. The selection lives in the parent and is
 * keyed by id, so it survives changing the search or department filter.
 */
function EmployeePicker({
  selected,
  onChange,
}: {
  selected: Map<string, EmployeeSummary>
  onChange: (next: Map<string, EmployeeSummary>) => void
}) {
  const [search, setSearch] = useState('')
  const [departmentIds, setDepartmentIds] = useState<string[]>([])

  const { data, isFetching } = useQuery({
    queryKey: ['employees', 'bonus-picker', search.trim(), departmentIds],
    queryFn: () =>
      getWithMeta<EmployeeSummary[]>('/employees', {
        search: search.trim() || undefined,
        departmentId: idsParam(departmentIds),
        employmentStatus: 'ACTIVE',
        pageSize: 200,
      }),
    staleTime: 30_000,
  })

  const shown = useMemo(() => data?.data ?? [], [data])
  const total = (data?.meta?.total as number | undefined) ?? shown.length
  const allShownSelected = shown.length > 0 && shown.every((employee) => selected.has(employee.id))

  const toggle = (employee: EmployeeSummary, checked: boolean): void => {
    const next = new Map(selected)
    if (checked) next.set(employee.id, employee)
    else next.delete(employee.id)
    onChange(next)
  }

  const toggleAllShown = (checked: boolean): void => {
    const next = new Map(selected)
    for (const employee of shown) {
      if (checked) next.set(employee.id, employee)
      else next.delete(employee.id)
    }
    onChange(next)
  }

  return (
    <Field label={`Employees (${selected.size} selected)`}>
      <div className="stack" style={{ gap: '0.5rem' }}>
        <div className="grid grid-2">
          <Input
            aria-label="Search employees"
            value={search}
            placeholder="Search by name or employee ID"
            onChange={(event) => setSearch(event.target.value)}
          />
          <DepartmentMultiSelector value={departmentIds} onChange={setDepartmentIds} />
        </div>

        <div
          style={{
            maxHeight: 220,
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '0.5rem 0.7rem',
          }}
        >
          <label className="row" style={{ gap: '0.5rem', alignItems: 'center', paddingBottom: '0.35rem' }}>
            <input
              type="checkbox"
              checked={allShownSelected}
              disabled={shown.length === 0}
              onChange={(event) => toggleAllShown(event.target.checked)}
            />
            <strong>Select everyone shown</strong>
          </label>
          {shown.map((employee) => (
            <label key={employee.id} className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={selected.has(employee.id)}
                onChange={(event) => toggle(employee, event.target.checked)}
              />
              <span>
                <strong>{employee.employeeCode}</strong> — {employee.fullName}
                {employee.departmentName ? <span className="subtle"> · {employee.departmentName}</span> : null}
              </span>
            </label>
          ))}
          {isFetching && shown.length === 0 ? <p className="subtle">Searching…</p> : null}
          {!isFetching && shown.length === 0 ? <p className="subtle">No matching employees.</p> : null}
        </div>

        {total > shown.length ? (
          <p className="field-message">
            Showing the first {shown.length} of {total}. Narrow the search or pick a department to see the rest.
          </p>
        ) : null}
      </div>
    </Field>
  )
}


// ---------------------------------------------------------------------------
// Bonus statement
// ---------------------------------------------------------------------------

/**
 * Month-by-month present days and wages for every employee over a range, and the
 * bonus a percentage of those wages comes to - the same figures a range-based
 * bonus is created from, so it can be checked (and downloaded) beforehand.
 */
function BonusStatementTab({ years }: { years: number[] }) {
  const toast = useToast()
  const { can } = useAuth()
  const range = lastFinancialYear(new Date())

  const [period, setPeriod] = useState<MonthRange>({ fromYear: range.fromYear, fromMonth: 4, toYear: range.toYear, toMonth: 3 })
  const [percentage, setPercentage] = useState('8.33')
  const [minManDays, setMinManDays] = useState('30')
  const [departmentIds, setDepartmentIds] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)

  const length = monthsInRange(period.fromYear, period.fromMonth, period.toYear, period.toMonth)
  const valid = length >= 1 && length <= 24 && Number(percentage) > 0 && Number(percentage) <= 100

  const params = {
    ...period,
    percentage: Number(percentage),
    minManDays: Number(minManDays) || 0,
    departmentId: idsParam(departmentIds),
  }

  const { data, isFetching, error } = useQuery({
    queryKey: ['bonuses', 'statement', params],
    queryFn: () => get<Statement>('/bonuses/statement', params),
    enabled: valid,
  })

  const runExport = async (): Promise<void> => {
    setExporting(true)
    try {
      await download(
        '/bonuses/statement/export',
        `bonus-${period.fromYear}-${String(period.fromMonth).padStart(2, '0')}-to-${period.toYear}-${String(period.toMonth).padStart(2, '0')}.xlsx`,
        params,
      )
    } catch (exportError) {
      toast.error('Export failed', exportError instanceof Error ? exportError.message : undefined)
    } finally {
      setExporting(false)
    }
  }

  const months = data?.months ?? []
  const rows = data?.rows ?? []
  const missing = months.filter((entry) => entry.runStatus === null)
  const unapproved = months.filter((entry) => entry.runStatus !== null && !['APPROVED', 'LOCKED'].includes(entry.runStatus))
  const heading = `Bonus @ ${Number(percentage)}%`

  return (
    <div className="stack">
      <Card
        title="Bonus statement"
        description="Wages come from each month's payroll: salary earnings only, not bonuses, overtime or adjustments. Man days count a half-day as half."
        actions={
          can('report.export') ? (
            <Button
              variant="secondary"
              icon={<FileSpreadsheet size={15} />}
              loading={exporting}
              disabled={!valid || rows.length === 0}
              onClick={() => void runExport()}
            >
              Excel
            </Button>
          ) : null
        }
      >
        <div className="stack">
          <MonthRangeFields
            idPrefix="statement"
            years={years}
            value={period}
            onChange={(next) => setPeriod({ ...period, ...next })}
            hint={length > 24 ? 'Choose a range of 24 months or fewer.' : length < 1 ? 'The end month is before the start month.' : undefined}
          />
          <div className="grid grid-3">
            <Field label="Percentage of total wages" htmlFor="statement-percentage">
              <Input
                id="statement-percentage"
                type="number"
                step="0.01"
                min="0.01"
                max="100"
                value={percentage}
                onChange={(event) => setPercentage(event.target.value)}
              />
            </Field>
            <Field label="Minimum man days" htmlFor="statement-min-days" hint="Below this, no bonus. 0 means no minimum.">
              <Input
                id="statement-min-days"
                type="number"
                step="0.5"
                min="0"
                value={minManDays}
                onChange={(event) => setMinManDays(event.target.value)}
              />
            </Field>
            <Field label="Department" htmlFor="statement-department">
              <DepartmentMultiSelector id="statement-department" value={departmentIds} onChange={setDepartmentIds} />
            </Field>
          </div>
        </div>
      </Card>

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

      {isFetching && rows.length === 0 ? (
        <Spinner label="Working out the bonus" />
      ) : error ? (
        <div className="alert alert-error">{error instanceof Error ? error.message : 'Could not load the statement'}</div>
      ) : (
        <>
          <div className="grid grid-4">
            <StatTile label="Eligible employees" value={data?.totals.employees ?? 0} tone="info" />
            <StatTile label="Man days" value={formatDays(data?.totals.manDays ?? 0)} tone="neutral" />
            <StatTile label="Total wages" value={formatCurrency(data?.totals.wages ?? 0)} tone="accent" />
            <StatTile label={heading} value={formatCurrency(data?.totals.bonus ?? 0)} tone="success" />
          </div>

          <Card padded={false} title="Employees">
            {rows.length === 0 ? (
              <p className="muted" style={{ padding: '2.5rem', textAlign: 'center' }}>
                No payroll found for these months.
              </p>
            ) : (
              <div className="data-table-wrapper">
                <table className="data-table">
                  <caption className="sr-only">Bonus statement</caption>
                  <thead>
                    <tr>
                      <th rowSpan={2}>Emp ID</th>
                      <th rowSpan={2}>Name</th>
                      <th rowSpan={2}>Department</th>
                      {months.map((entry) => (
                        <th key={entry.label} colSpan={2} className="align-right">
                          {entry.label}
                        </th>
                      ))}
                      <th rowSpan={2} className="align-right">Man days</th>
                      <th rowSpan={2} className="align-right">Total wages</th>
                      <th rowSpan={2}>Eligible</th>
                      <th rowSpan={2} className="align-right">{heading}</th>
                    </tr>
                    <tr>
                      {months.map((entry) => (
                        <FragmentHeads key={entry.label} />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.employeeId}>
                        <td data-label="Emp ID">{row.employeeCode}</td>
                        <td data-label="Name">{row.employeeName}</td>
                        <td data-label="Department">{row.departmentName ?? '—'}</td>
                        {row.months.map((cell, index) => (
                          <MonthCells key={months[index]?.label ?? index} manDays={cell.manDays} wages={cell.wages} />
                        ))}
                        <td data-label="Man days" className="align-right">{formatDays(row.totalManDays)}</td>
                        <td data-label="Total wages" className="align-right">{formatCurrency(row.totalWages)}</td>
                        <td data-label="Eligible">{row.eligible ? 'Yes' : 'No'}</td>
                        <td data-label={heading} className="align-right">
                          <strong>{formatCurrency(row.bonus)}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {(data?.summary.length ?? 0) > 0 ? (
            <Card title="Summary of eligible employees" padded={false}>
              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Department</th>
                      <th className="align-right">Employees</th>
                      <th className="align-right">Man days</th>
                      <th className="align-right">{heading}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.summary.map((entry) => (
                      <tr key={entry.departmentName}>
                        <td data-label="Department">{entry.departmentName}</td>
                        <td data-label="Employees" className="align-right">{entry.employees}</td>
                        <td data-label="Man days" className="align-right">{formatDays(entry.manDays)}</td>
                        <td data-label={heading} className="align-right">{formatCurrency(entry.bonus)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Grand total</td>
                      <td className="align-right">{data?.totals.employees}</td>
                      <td className="align-right">{formatDays(data?.totals.manDays ?? 0)}</td>
                      <td className="align-right">{formatCurrency(data?.totals.bonus ?? 0)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  )
}

/** The "Days | Wages" pair under a month heading. */
function FragmentHeads() {
  return (
    <>
      <th className="align-right">Days</th>
      <th className="align-right">Wages</th>
    </>
  )
}

function MonthCells({ manDays, wages }: { manDays: number; wages: number }) {
  return (
    <>
      <td className="align-right">{manDays === 0 ? '—' : formatDays(manDays)}</td>
      <td className="align-right">{wages === 0 ? '—' : formatCurrency(wages)}</td>
    </>
  )
}
