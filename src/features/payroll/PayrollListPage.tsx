import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { del, getWithMeta, post } from '../../lib/api'
import { MONTH_NAMES, formatCurrency, formatDate } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Button, Card, ConfirmDialog, Field, Input, Modal, PageHeader, Pagination, Select, StatusBadge, Textarea } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import type { PayrollRun } from '../../types/api'

const pad = (value: number): string => String(value).padStart(2, '0')

/** The standard cycle: the 21st of the previous month through the 20th of the named month. */
function standardPeriod(year: number, month: number): { periodStart: string; periodEnd: string } {
  const previousYear = month === 1 ? year - 1 : year
  const previousMonth = month === 1 ? 12 : month - 1
  return { periodStart: `${previousYear}-${pad(previousMonth)}-21`, periodEnd: `${year}-${pad(month)}-20` }
}

/** Payroll runs: one per month, each moving through its own lifecycle. */
export default function PayrollListPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can } = useAuth()

  const now = new Date()
  const [page, setPage] = useState(1)
  const [year, setYear] = useState('')
  const [status, setStatus] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<PayrollRun | null>(null)
  const initialMonth = now.getMonth() === 0 ? 12 : now.getMonth()
  const [form, setForm] = useState({
    year: now.getFullYear(),
    month: initialMonth,
    notes: '',
    ...standardPeriod(now.getFullYear(), initialMonth),
  })
  // Once the dates are edited by hand, changing the month no longer resets them.
  const [datesEdited, setDatesEdited] = useState(false)

  const changeMonth = (next: { year?: number; month?: number }): void => {
    const year = next.year ?? form.year
    const month = next.month ?? form.month
    setForm({ ...form, year, month, ...(datesEdited ? {} : standardPeriod(year, month)) })
  }

  const filters = { page, pageSize: 20, year: year || undefined, status: status || undefined }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['payroll', 'runs', filters],
    queryFn: () => getWithMeta<PayrollRun[]>('/payroll/runs', filters),
    placeholderData: keepPreviousData,
  })

  const createMutation = useMutation({
    mutationFn: () =>
      post<PayrollRun>('/payroll/runs', {
        year: form.year,
        month: form.month,
        notes: form.notes || null,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
      }),
    onSuccess: async (response) => {
      toast.success('Payroll run created', 'Next: calculate it.')
      setCreating(false)
      await queryClient.invalidateQueries({ queryKey: ['payroll'] })
      navigate(`/payroll/runs/${response.data.id}`)
    },
    onError: (mutationError: Error) => toast.error('Could not create the run', mutationError.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (run: PayrollRun) => del(`/payroll/runs/${run.id}`),
    onSuccess: async () => {
      toast.success('Payroll run deleted')
      setDeleteTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['payroll'] })
    },
    onError: (mutationError: Error) => {
      setDeleteTarget(null)
      toast.error('Could not delete the run', mutationError.message)
    },
  })

  const columns: Column<PayrollRun>[] = [
    {
      key: 'period',
      header: 'Period',
      render: (row) => (
        <div>
          <Link to={`/payroll/runs/${row.id}`} onClick={(event) => event.stopPropagation()}>
            <strong>{row.monthLabel}</strong>
          </Link>
          <p className="subtle">
            {formatDate(row.periodStart)} → {formatDate(row.periodEnd)}
          </p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'employees', header: 'Employees', align: 'right', render: (row) => row.totalEmployees },
    { key: 'gross', header: 'Gross', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.totalGross) },
    { key: 'deductions', header: 'Deductions', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.totalDeductions) },
    { key: 'net', header: 'Net', align: 'right', render: (row) => <strong>{formatCurrency(row.totalNet)}</strong> },
    {
      key: 'payment',
      header: 'Paid / pending',
      align: 'right',
      render: (row) => (
        <span>
          {formatCurrency(row.totalPaid)}
          <span className="subtle"> / {formatCurrency(row.totalPending)}</span>
        </span>
      ),
    },
    ...(can('payroll.delete')
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            render: (row: PayrollRun) =>
              row.status === 'DRAFT' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={13} />}
                  onClick={(event) => {
                    event.stopPropagation()
                    setDeleteTarget(row)
                  }}
                >
                  Delete
                </Button>
              ) : null,
          },
        ]
      : []),
  ]

  const years = Array.from({ length: 5 }, (_, index) => now.getFullYear() - index)

  return (
    <div className="page">
      <PageHeader
        title="Payroll runs"
        description="Each month is calculated once, reviewed, approved and then locked."
        actions={
          can('payroll.process') ? (
            <Button icon={<Plus size={15} />} onClick={() => setCreating(true)}>
              New payroll run
            </Button>
          ) : null
        }
      />

      <Card padded={false}>
        <div className="filter-bar">
          <Field label="Year" htmlFor="payroll-year">
            <Select
              id="payroll-year"
              value={year}
              onChange={(event) => {
                setYear(event.target.value)
                setPage(1)
              }}
            >
              <option value="">All years</option>
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Status" htmlFor="payroll-status">
            <Select
              id="payroll-status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value)
                setPage(1)
              }}
            >
              <option value="">All statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="CALCULATED">Calculated</option>
              <option value="UNDER_REVIEW">Under review</option>
              <option value="APPROVED">Approved</option>
              <option value="LOCKED">Locked</option>
            </Select>
          </Field>
        </div>

        <DataTable
          columns={columns}
          rows={data?.data ?? []}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          onRowClick={(row) => navigate(`/payroll/runs/${row.id}`)}
          emptyTitle="No payroll runs yet"
          emptyDescription="Create a run for a month to get started."
          caption="Payroll runs"
        />

        {data?.meta ? (
          <Pagination
            page={data.meta.page ?? 1}
            pageSize={data.meta.pageSize ?? 20}
            total={data.meta.total ?? 0}
            totalPages={data.meta.totalPages ?? 1}
            onPageChange={setPage}
          />
        ) : null}
      </Card>

      <Modal
        open={creating}
        title="New payroll run"
        description="One run per month. You can recalculate it as often as you need until it is approved."
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              loading={createMutation.isPending}
              disabled={!form.periodStart || !form.periodEnd || form.periodEnd < form.periodStart}
              onClick={() => createMutation.mutate()}
            >
              Create run
            </Button>
          </>
        }
      >
        <div className="stack">
          <div className="grid grid-2">
            <Field label="Month" htmlFor="run-month" required>
              <Select id="run-month" value={form.month} onChange={(event) => changeMonth({ month: Number(event.target.value) })}>
                {MONTH_NAMES.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Year" htmlFor="run-year" required>
              <Select id="run-year" value={form.year} onChange={(event) => changeMonth({ year: Number(event.target.value) })}>
                {years.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-2">
            <Field label="Period starts" htmlFor="run-start" required>
              <Input
                id="run-start"
                type="date"
                value={form.periodStart}
                onChange={(event) => {
                  setDatesEdited(true)
                  setForm({ ...form, periodStart: event.target.value })
                }}
              />
            </Field>
            <Field
              label="Period ends"
              htmlFor="run-end"
              required
              hint="Starts as the 21st of last month to the 20th; change either date if this run covers different days."
            >
              <Input
                id="run-end"
                type="date"
                value={form.periodEnd}
                onChange={(event) => {
                  setDatesEdited(true)
                  setForm({ ...form, periodEnd: event.target.value })
                }}
              />
            </Field>
          </div>
          <Field label="Notes" htmlFor="run-notes">
            <Textarea id="run-notes" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete payroll run"
        message={`This run for ${deleteTarget?.monthLabel} has not been calculated yet. Deleting it removes it permanently - it can be recreated for the same month afterwards.`}
        confirmLabel="Delete run"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
