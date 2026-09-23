import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { del, get, post } from '../../lib/api'
import { MONTH_NAMES, formatCurrency } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Badge, Button, Card, ConfirmDialog, Field, Input, PageHeader, Select, StatTile, Textarea } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { EmployeeSelector } from '../../components/forms/selectors'
import type { PayrollAdjustment } from '../../types/api'

/**
 * Other Deductions: a one-off amount taken out of an employee's pay for a
 * chosen payroll month - a penalty, a recovery for damaged/lost property, an
 * advance recovery, or anything else that isn't tax, PF or ESI.
 *
 * This is a thin, purpose-built view over the general payroll adjustment
 * mechanism (see payroll.service.ts::createAdjustment) that already feeds
 * calculateRun(): every entry here is a DEDUCTION-type adjustment whose
 * component code carries the `OD_` prefix, which is what separates it from
 * other adjustment uses (corrections, arrears, reversals) in the same table.
 */

const CATEGORIES = [
  { code: 'OD_PENALTY', label: 'Penalty' },
  { code: 'OD_DAMAGE', label: 'Damage / loss recovery' },
  { code: 'OD_ADVANCE', label: 'Advance recovery' },
  { code: 'OD_OTHER', label: 'Other' },
] as const

const CATEGORY_PREFIX = 'OD_'

function categoryLabel(componentCode: string, componentName: string): string {
  return CATEGORIES.find((category) => category.code === componentCode)?.label ?? componentName
}

export default function OtherDeductionsPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const canManage = can('payroll.adjust')

  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState<number | ''>('')
  const [employeeId, setEmployeeId] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<PayrollAdjustment | null>(null)

  const filters = {
    componentCodePrefix: CATEGORY_PREFIX,
    year,
    month: month === '' ? undefined : month,
    employeeId: employeeId || undefined,
  }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['payroll', 'adjustments', 'other-deductions', filters],
    queryFn: () => get<PayrollAdjustment[]>('/payroll/adjustments', filters),
  })

  const deleteMutation = useMutation({
    mutationFn: (row: PayrollAdjustment) => del(`/payroll/adjustments/${row.id}`),
    onSuccess: async () => {
      toast.success('Deduction removed')
      setDeleteTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['payroll', 'adjustments', 'other-deductions'] })
    },
    onError: (mutationError: Error) => {
      setDeleteTarget(null)
      toast.error('Could not remove the deduction', mutationError.message)
    },
  })

  const rows = data ?? []
  const total = rows.reduce((sum, row) => sum + row.amount, 0)
  const years = Array.from({ length: 5 }, (_, index) => now.getFullYear() + 1 - index)

  const columns: Column<PayrollAdjustment>[] = [
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
    { key: 'category', header: 'Category', render: (row) => categoryLabel(row.componentCode, row.componentName) },
    { key: 'amount', header: 'Amount', align: 'right', render: (row) => <strong>{formatCurrency(row.amount)}</strong> },
    { key: 'reason', header: 'Reason', hideOnMobile: true, render: (row) => row.reason },
    { key: 'month', header: 'Payroll month', render: (row) => `${MONTH_NAMES[row.applyMonth - 1]} ${row.applyYear}` },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (row.appliedAt ? <Badge tone="success">Applied</Badge> : <Badge tone="neutral">Pending</Badge>),
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            render: (row: PayrollAdjustment) =>
              row.appliedAt ? null : (
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDeleteTarget(row)}>
                  Remove
                </Button>
              ),
          },
        ]
      : []),
  ]

  return (
    <div className="page">
      <PageHeader
        title="Other Deductions"
        description="A one-off deduction for a chosen payroll month, such as a penalty or a recovery. Applied automatically when that month's payroll is calculated."
      />

      {canManage ? <AddDeductionForm years={years} /> : null}

      <div className="grid grid-2">
        <StatTile label="Deductions" value={rows.length} tone="info" />
        <StatTile label="Total amount" value={formatCurrency(total)} tone="success" />
      </div>

      <Card padded={false}>
        <div className="filter-bar">
          <Field label="Year" htmlFor="od-year">
            <Select id="od-year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Month" htmlFor="od-month">
            <Select
              id="od-month"
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
          <Field label="Employee" htmlFor="od-employee-filter">
            <EmployeeSelector id="od-employee-filter" value={employeeId} onChange={setEmployeeId} />
          </Field>
        </div>

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          emptyTitle="No other deductions for this period"
          caption="Other deductions"
        />
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove deduction"
        message={`Remove the ${deleteTarget ? formatCurrency(deleteTarget.amount) : ''} deduction for ${deleteTarget?.employeeName}?`}
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
// Add deduction
// ---------------------------------------------------------------------------

function AddDeductionForm({ years }: { years: number[] }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const now = new Date()

  const emptyForm = {
    employeeId: '',
    category: CATEGORIES[0].code as string,
    amount: '',
    reason: '',
    applyYear: now.getFullYear(),
    applyMonth: now.getMonth() + 1,
  }
  const [form, setForm] = useState(emptyForm)

  const createMutation = useMutation({
    mutationFn: () => {
      const category = CATEGORIES.find((entry) => entry.code === form.category) ?? CATEGORIES[CATEGORIES.length - 1]
      return post('/payroll/adjustments', {
        employeeId: form.employeeId,
        adjustmentType: 'RECOVERY',
        componentCode: category.code,
        componentName: category.label,
        componentType: 'DEDUCTION',
        amount: Number(form.amount),
        applyYear: form.applyYear,
        applyMonth: form.applyMonth,
        reason: form.reason.trim(),
      })
    },
    onSuccess: async () => {
      toast.success('Deduction added')
      await queryClient.invalidateQueries({ queryKey: ['payroll', 'adjustments', 'other-deductions'] })
      setForm(emptyForm)
    },
    onError: (mutationError: Error) => toast.error('Could not add the deduction', mutationError.message),
  })

  const canSubmit = Boolean(form.employeeId) && Number(form.amount) > 0 && form.reason.trim().length >= 3

  return (
    <Card title="Add a deduction">
      <div className="stack">
        <div className="grid grid-3">
          <Field label="Employee" htmlFor="od-employee" required>
            <EmployeeSelector id="od-employee" value={form.employeeId} onChange={(value) => setForm({ ...form, employeeId: value })} />
          </Field>
          <Field label="Category" htmlFor="od-category" required>
            <Select id="od-category" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
              {CATEGORIES.map((category) => (
                <option key={category.code} value={category.code}>
                  {category.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" htmlFor="od-amount" required>
            <Input
              id="od-amount"
              type="number"
              step="0.01"
              min="0.01"
              value={form.amount}
              onChange={(event) => setForm({ ...form, amount: event.target.value })}
            />
          </Field>
        </div>

        <div className="grid grid-2">
          <Field label="Payroll month" htmlFor="od-payroll-month" required>
            <Select
              id="od-payroll-month"
              value={form.applyMonth}
              onChange={(event) => setForm({ ...form, applyMonth: Number(event.target.value) })}
            >
              {MONTH_NAMES.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payroll year" htmlFor="od-payroll-year" required>
            <Select
              id="od-payroll-year"
              value={form.applyYear}
              onChange={(event) => setForm({ ...form, applyYear: Number(event.target.value) })}
            >
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Reason" htmlFor="od-reason" required hint="Shown to the employee and kept with the payroll record.">
          <Textarea id="od-reason" rows={2} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        </Field>

        <div>
          <Button icon={<Plus size={15} />} loading={createMutation.isPending} disabled={!canSubmit} onClick={() => createMutation.mutate()}>
            Add deduction
          </Button>
        </div>
      </div>
    </Card>
  )
}
