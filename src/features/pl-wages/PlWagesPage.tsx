import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, Play, Trash2, Wallet } from 'lucide-react'
import { del, get, patch, post } from '../../lib/api'
import { formatCurrency, formatDays } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Badge, Button, Card, ConfirmDialog, Field, PageHeader, Select, StatTile } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { EmployeeSelector } from '../../components/forms/selectors'
import { MarkPaidModal, PayoutSummary } from '../../components/forms/Payout'
import type { PlWagesCredit } from '../../types/api'

/**
 * PL Wages: an annual credit for earned-leave wages. An employee who worked at
 * least 20 days in at least 3 separate months of the year earns one day's
 * wage for every 20 days worked across the whole year, at the most recent
 * daily rate they were actually paid. Generated once a year, reviewed and
 * approved, then paid separately from salary and marked paid with the date,
 * how it was paid and a supporting document - one credit or many at once.
 */

const STATUS_TONE: Record<PlWagesCredit['status'], 'neutral' | 'warning' | 'info' | 'success'> = {
  NOT_ELIGIBLE: 'neutral',
  PENDING: 'info',
  APPROVED: 'warning',
  PAID: 'success',
}

const STATUS_LABEL: Record<PlWagesCredit['status'], string> = {
  NOT_ELIGIBLE: 'Not eligible',
  PENDING: 'Pending review',
  APPROVED: 'Not paid',
  PAID: 'Paid',
}

export default function PlWagesPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const canManage = can('plwages.manage') || can('plwages.manage.team')

  const now = new Date()
  const [creditYear, setCreditYear] = useState(now.getFullYear() - 1)
  const [status, setStatus] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<PlWagesCredit | null>(null)
  const [unpaidTarget, setUnpaidTarget] = useState<PlWagesCredit | null>(null)
  // The credits the payment dialog is open for, and the one being corrected, if any.
  const [paying, setPaying] = useState<{ ids: string[]; row: PlWagesCredit | null } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const filters = { creditYear, status: status || undefined, employeeId: employeeId || undefined }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['pl-wages', filters],
    queryFn: () => get<PlWagesCredit[]>('/pl-wages', filters),
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pl-wages'] })

  const generateMutation = useMutation({
    mutationFn: () => post('/pl-wages/generate', { creditYear }),
    onSuccess: async (response) => {
      toast.success(response.message ?? 'Generated')
      await refresh()
    },
    onError: (mutationError: Error) => toast.error('Could not generate', mutationError.message),
  })

  const approveMutation = useMutation({
    mutationFn: (row: PlWagesCredit) => patch(`/pl-wages/${row.id}/approve`),
    onSuccess: async () => {
      toast.success('Approved, ready to pay')
      await refresh()
    },
    onError: (mutationError: Error) => toast.error('Could not approve', mutationError.message),
  })

  const bulkApproveMutation = useMutation({
    mutationFn: (ids: string[]) => post('/pl-wages/approve', { ids }),
    onSuccess: async (response) => {
      toast.success(response.message ?? 'Approved')
      setSelected(new Set())
      await refresh()
    },
    onError: (mutationError: Error) => toast.error('Could not approve', mutationError.message),
  })

  const unpaidMutation = useMutation({
    mutationFn: (row: PlWagesCredit) => patch(`/pl-wages/${row.id}/mark-unpaid`),
    onSuccess: async () => {
      toast.success('Marked as not paid')
      setUnpaidTarget(null)
      await refresh()
    },
    onError: (mutationError: Error) => {
      setUnpaidTarget(null)
      toast.error('Could not mark as not paid', mutationError.message)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (row: PlWagesCredit) => del(`/pl-wages/${row.id}`),
    onSuccess: async () => {
      toast.success('Row removed')
      setDeleteTarget(null)
      await refresh()
    },
    onError: (mutationError: Error) => {
      setDeleteTarget(null)
      toast.error('Could not remove the row', mutationError.message)
    },
  })

  const rows = data ?? []
  const years = Array.from({ length: 6 }, (_, index) => now.getFullYear() - index)
  const sum = (list: PlWagesCredit[]): number => list.reduce((value, row) => value + row.creditAmount, 0)
  const eligibleRows = rows.filter((row) => row.status !== 'NOT_ELIGIBLE')
  const pendingRows = rows.filter((row) => row.status === 'PENDING')
  const unpaidRows = rows.filter((row) => row.status === 'APPROVED')
  const paidRows = rows.filter((row) => row.status === 'PAID')

  // A selection can hold credits to approve and credits to pay; each action
  // takes the ones it applies to.
  const selectable = rows.filter((row) => row.status === 'PENDING' || row.status === 'APPROVED')
  const selectedPending = pendingRows.filter((row) => selected.has(row.id))
  const selectedUnpaid = unpaidRows.filter((row) => selected.has(row.id))
  const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(row.id))
  const toggle = (id: string, checked: boolean): void => {
    const next = new Set(selected)
    if (checked) next.add(id)
    else next.delete(id)
    setSelected(next)
  }

  const payingRows = paying ? rows.filter((row) => paying.ids.includes(row.id)) : []

  const columns: Column<PlWagesCredit>[] = [
    ...(canManage
      ? [
          {
            key: 'select',
            header: '',
            render: (row: PlWagesCredit) =>
              row.status === 'PENDING' || row.status === 'APPROVED' ? (
                <input
                  type="checkbox"
                  aria-label={`Select ${row.employeeName ?? row.employeeCode ?? ''}`}
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
    { key: 'months', header: 'Qualifying months', align: 'right', render: (row) => row.qualifyingMonths },
    { key: 'days', header: 'Days worked', align: 'right', hideOnMobile: true, render: (row) => formatDays(row.totalDaysWorked) },
    { key: 'eligibleDays', header: 'Eligible days', align: 'right', render: (row) => row.eligibleDays },
    { key: 'rate', header: 'Daily rate', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.dailyWageRate) },
    { key: 'amount', header: 'Credit amount', align: 'right', render: (row) => <strong>{formatCurrency(row.creditAmount)}</strong> },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div>
          <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
          {row.status === 'PAID' ? (
            <PayoutSummary payout={row} proofPath={`/pl-wages/${row.id}/proof`} proofName={`pl-wages-${row.employeeCode ?? row.id}-${row.creditYear}`} />
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
            render: (row: PlWagesCredit) => (
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
                {row.status === 'PENDING' || row.status === 'NOT_ELIGIBLE' ? (
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDeleteTarget(row)}>
                    Remove
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
                ) : null}
              </div>
            ),
          },
        ]
      : []),
  ]

  return (
    <div className="page">
      <PageHeader
        title="PL Wages"
        description="An annual credit for earned-leave wages: 1 day's pay for every 20 days worked in the year, for anyone who worked at least 20 days in 3 or more separate months. PL Wages are paid separately from salary."
      />

      {canManage ? (
        <Card
          title="Generate for a year"
          description="Assesses every employee with payroll that year. Best run once every month of the year has been approved. Existing rows that are already approved or paid are left untouched."
        >
          <div className="row" style={{ gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Credit year" htmlFor="pl-gen-year">
              <Select id="pl-gen-year" value={creditYear} onChange={(event) => setCreditYear(Number(event.target.value))}>
                {years.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Button icon={<Play size={15} />} loading={generateMutation.isPending} onClick={() => generateMutation.mutate()}>
              Generate
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-4">
        <StatTile label="Total credit" value={formatCurrency(sum(eligibleRows))} sublabel={`${eligibleRows.length} eligible of ${rows.length}`} tone="accent" />
        <StatTile label="Paid" value={formatCurrency(sum(paidRows))} sublabel={`${paidRows.length} paid`} tone="success" />
        <StatTile label="Not paid yet" value={formatCurrency(sum(unpaidRows))} sublabel={`${unpaidRows.length} approved, waiting to be paid`} tone="warning" />
        <StatTile label="Pending review" value={pendingRows.length} sublabel={formatCurrency(sum(pendingRows))} tone="info" />
      </div>

      <Card padded={false}>
        <div className="filter-bar">
          <Field label="Credit year" htmlFor="pl-year">
            <Select id="pl-year" value={creditYear} onChange={(event) => setCreditYear(Number(event.target.value))}>
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status" htmlFor="pl-status">
            <Select id="pl-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="NOT_ELIGIBLE">Not eligible</option>
              <option value="PENDING">Pending review</option>
              <option value="APPROVED">Not paid</option>
              <option value="PAID">Paid</option>
            </Select>
          </Field>
          <Field label="Employee" htmlFor="pl-employee-filter">
            <EmployeeSelector id="pl-employee-filter" value={employeeId} onChange={setEmployeeId} />
          </Field>
        </div>

        {canManage && selectable.length > 0 ? (
          <div className="row" style={{ gap: '0.5rem', padding: '0 1rem 0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((row) => row.id)))}
            >
              {allSelected ? 'Clear selection' : `Select all to approve or pay (${selectable.length})`}
            </Button>
            {selectedPending.length > 0 ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<BadgeCheck size={13} />}
                loading={bulkApproveMutation.isPending}
                onClick={() => bulkApproveMutation.mutate(selectedPending.map((row) => row.id))}
              >
                Approve {selectedPending.length}
              </Button>
            ) : null}
            {selectedUnpaid.length > 0 ? (
              <Button size="sm" icon={<Wallet size={13} />} onClick={() => setPaying({ ids: selectedUnpaid.map((row) => row.id), row: null })}>
                Mark {selectedUnpaid.length} paid · {formatCurrency(sum(selectedUnpaid))}
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
          emptyTitle="No PL Wages rows for this year"
          caption="PL Wages"
        />
      </Card>

      <MarkPaidModal
        open={paying !== null}
        title={paying?.row ? 'Edit payment' : 'Mark as paid'}
        description={
          paying?.row
            ? `How the ${formatCurrency(paying.row.creditAmount)} PL Wages for ${paying.row.employeeName ?? paying.row.employeeCode} was paid.`
            : payingRows.length > 1
              ? `Record that these ${payingRows.length} PL Wages credits, ${formatCurrency(sum(payingRows))} in all, have been paid.`
              : `Record that the ${formatCurrency(sum(payingRows))} PL Wages for ${payingRows[0]?.employeeName ?? 'this employee'} has been paid.`
        }
        basePath="/pl-wages"
        ids={paying?.ids ?? []}
        initial={paying?.row ?? null}
        queryKey="pl-wages"
        onClose={() => setPaying(null)}
        onDone={() => setSelected(new Set())}
      />

      <ConfirmDialog
        open={unpaidTarget !== null}
        title="Mark as not paid"
        message={`Mark the ${unpaidTarget ? formatCurrency(unpaidTarget.creditAmount) : ''} PL Wages for ${unpaidTarget?.employeeName ?? ''} as not paid? Its payment details and supporting document are removed.`}
        confirmLabel="Mark not paid"
        tone="danger"
        loading={unpaidMutation.isPending}
        onConfirm={() => unpaidTarget && unpaidMutation.mutate(unpaidTarget)}
        onCancel={() => setUnpaidTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove row"
        message={`Remove the PL Wages row for ${deleteTarget?.employeeName}?`}
        confirmLabel="Remove"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
