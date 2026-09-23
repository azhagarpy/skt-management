import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Send, Trash2 } from 'lucide-react'
import { del, get, patch, post } from '../../lib/api'
import { MONTH_NAMES, formatCurrency, formatDays } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Badge, Button, Card, ConfirmDialog, Field, Modal, PageHeader, Select, StatTile } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { EmployeeSelector } from '../../components/forms/selectors'
import type { PlWagesCredit } from '../../types/api'

/**
 * PL Wages: an annual credit for earned-leave wages. An employee who worked at
 * least 20 days in at least 3 separate months of the year earns one day's
 * wage for every 20 days worked across the whole year, at the most recent
 * daily rate they were actually paid. Generated once a year, reviewed, then
 * released into a chosen payroll month, where it is paid as an earning.
 */

const STATUS_TONE: Record<PlWagesCredit['status'], 'neutral' | 'warning' | 'info' | 'success'> = {
  NOT_ELIGIBLE: 'neutral',
  PENDING: 'warning',
  APPROVED: 'info',
  PAID: 'success',
}

const STATUS_LABEL: Record<PlWagesCredit['status'], string> = {
  NOT_ELIGIBLE: 'Not eligible',
  PENDING: 'Pending review',
  APPROVED: 'Released to payroll',
  PAID: 'Paid',
}

export default function PlWagesPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const canManage = can('plwages.manage')

  const now = new Date()
  const [creditYear, setCreditYear] = useState(now.getFullYear() - 1)
  const [status, setStatus] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [releaseTarget, setReleaseTarget] = useState<PlWagesCredit | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PlWagesCredit | null>(null)

  const filters = { creditYear, status: status || undefined, employeeId: employeeId || undefined }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['pl-wages', filters],
    queryFn: () => get<PlWagesCredit[]>('/pl-wages', filters),
  })

  const generateMutation = useMutation({
    mutationFn: () => post('/pl-wages/generate', { creditYear }),
    onSuccess: async (response) => {
      toast.success(response.message ?? 'Generated')
      await queryClient.invalidateQueries({ queryKey: ['pl-wages'] })
    },
    onError: (mutationError: Error) => toast.error('Could not generate', mutationError.message),
  })

  const markPaidMutation = useMutation({
    mutationFn: (row: PlWagesCredit) => patch(`/pl-wages/${row.id}/mark-paid`),
    onSuccess: async () => {
      toast.success('Marked as paid')
      await queryClient.invalidateQueries({ queryKey: ['pl-wages'] })
    },
    onError: (mutationError: Error) => toast.error('Could not mark as paid', mutationError.message),
  })

  const markUnpaidMutation = useMutation({
    mutationFn: (row: PlWagesCredit) => patch(`/pl-wages/${row.id}/mark-unpaid`),
    onSuccess: async () => {
      toast.success('Marked as not paid')
      await queryClient.invalidateQueries({ queryKey: ['pl-wages'] })
    },
    onError: (mutationError: Error) => toast.error('Could not revert', mutationError.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (row: PlWagesCredit) => del(`/pl-wages/${row.id}`),
    onSuccess: async () => {
      toast.success('Row removed')
      setDeleteTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['pl-wages'] })
    },
    onError: (mutationError: Error) => {
      setDeleteTarget(null)
      toast.error('Could not remove the row', mutationError.message)
    },
  })

  const rows = data ?? []
  const years = Array.from({ length: 6 }, (_, index) => now.getFullYear() - index)
  const eligibleRows = rows.filter((row) => row.status !== 'NOT_ELIGIBLE')
  const totalCredit = eligibleRows.reduce((sum, row) => sum + row.creditAmount, 0)

  const columns: Column<PlWagesCredit>[] = [
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
          {row.payrollYear && row.payrollMonth ? (
            <p className="subtle">
              {MONTH_NAMES[row.payrollMonth - 1]} {row.payrollYear}
            </p>
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
                  <>
                    <Button size="sm" variant="secondary" icon={<Send size={13} />} onClick={() => setReleaseTarget(row)}>
                      Release
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDeleteTarget(row)}>
                      Remove
                    </Button>
                  </>
                ) : null}
                {row.status === 'NOT_ELIGIBLE' ? (
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDeleteTarget(row)}>
                    Remove
                  </Button>
                ) : null}
                {row.status === 'APPROVED' ? (
                  <Button size="sm" variant="secondary" onClick={() => markPaidMutation.mutate(row)} loading={markPaidMutation.isPending}>
                    Mark paid
                  </Button>
                ) : null}
                {row.status === 'PAID' ? (
                  <Button size="sm" variant="ghost" onClick={() => markUnpaidMutation.mutate(row)} loading={markUnpaidMutation.isPending}>
                    Mark not paid
                  </Button>
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
        description="An annual credit for earned-leave wages: 1 day's pay for every 20 days worked in the year, for anyone who worked at least 20 days in 3 or more separate months."
      />

      {canManage ? (
        <Card
          title="Generate for a year"
          description="Assesses every employee with payroll that year. Best run once every month of the year has been approved. Existing rows that are already released or paid are left untouched."
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
        <StatTile label="Rows" value={rows.length} tone="info" />
        <StatTile label="Eligible" value={eligibleRows.length} tone="accent" />
        <StatTile label="Total credit" value={formatCurrency(totalCredit)} tone="success" />
        <StatTile label="Pending review" value={rows.filter((row) => row.status === 'PENDING').length} tone="warning" />
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
              <option value="APPROVED">Released to payroll</option>
              <option value="PAID">Paid</option>
            </Select>
          </Field>
          <Field label="Employee" htmlFor="pl-employee-filter">
            <EmployeeSelector id="pl-employee-filter" value={employeeId} onChange={setEmployeeId} />
          </Field>
        </div>

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

      <ReleaseModal target={releaseTarget} onClose={() => setReleaseTarget(null)} />

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

// ---------------------------------------------------------------------------
// Release into payroll
// ---------------------------------------------------------------------------

function ReleaseModal({ target, onClose }: { target: PlWagesCredit | null; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const now = new Date()
  const defaultYear = target ? target.creditYear + 1 : now.getFullYear()

  const [payrollYear, setPayrollYear] = useState(defaultYear)
  const [payrollMonth, setPayrollMonth] = useState(1)

  const close = (): void => {
    setPayrollYear(defaultYear)
    setPayrollMonth(1)
    onClose()
  }

  const releaseMutation = useMutation({
    mutationFn: () => patch(`/pl-wages/${target?.id}/approve`, { payrollYear, payrollMonth }),
    onSuccess: async () => {
      toast.success('Released into payroll')
      await queryClient.invalidateQueries({ queryKey: ['pl-wages'] })
      close()
    },
    onError: (mutationError: Error) => toast.error('Could not release', mutationError.message),
  })

  const years = Array.from({ length: 6 }, (_, index) => defaultYear + 1 - index)

  return (
    <Modal
      open={target !== null}
      title="Release into payroll"
      description={
        target
          ? `${target.employeeName} will receive ${formatCurrency(target.creditAmount)} as an earning in the payroll month you choose.`
          : undefined
      }
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button loading={releaseMutation.isPending} onClick={() => releaseMutation.mutate()}>
            Release
          </Button>
        </>
      }
    >
      <div className="grid grid-2">
        <Field label="Payroll month" htmlFor="pl-release-month" required>
          <Select id="pl-release-month" value={payrollMonth} onChange={(event) => setPayrollMonth(Number(event.target.value))}>
            {MONTH_NAMES.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Payroll year" htmlFor="pl-release-year" required>
          <Select id="pl-release-year" value={payrollYear} onChange={(event) => setPayrollYear(Number(event.target.value))}>
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}
