import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, Calculator, CalendarRange, Download, FileText, Lock, MessageCircle, Send, Trash2, Wallet } from 'lucide-react'
import { del, download, downloadPost, get, getWithMeta, patch, post } from '../../lib/api'
import { formatCurrency, formatDate, formatDateTime, formatDays } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Spinner,
  StatTile,
  StatusBadge,
} from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { DepartmentSelector } from '../../components/forms/selectors'
import type { PayrollItem, PayrollRun } from '../../types/api'

interface CalculationResult {
  run: PayrollRun
  employeesProcessed: number
  skipped: { employeeId: string; employeeCode: string; reason: string }[]
  warnings: { employeeCode: string; warnings: string[] }[]
}

/**
 * A single payroll run.
 *
 * The action bar reflects the run's lifecycle: calculate, review, approve, lock
 * (plan section 28). Once locked, the figures and the attendance behind them are
 * read-only.
 */
export default function PayrollRunPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can } = useAuth()

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [paymentStatus, setPaymentStatus] = useState('')
  const [confirm, setConfirm] = useState<null | 'approve' | 'lock' | 'delete'>(null)
  const [calculation, setCalculation] = useState<CalculationResult | null>(null)
  const [editingPeriod, setEditingPeriod] = useState(false)
  const [period, setPeriod] = useState({ periodStart: '', periodEnd: '' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [downloading, setDownloading] = useState<'selected' | 'all' | null>(null)
  const [confirmingWhatsApp, setConfirmingWhatsApp] = useState(false)

  const runQuery = useQuery({
    queryKey: ['payroll', 'run', id],
    queryFn: () => get<PayrollRun>(`/payroll/runs/${id}`),
    enabled: Boolean(id),
  })

  const filters = {
    page,
    pageSize: 25,
    search: search || undefined,
    departmentId: departmentId || undefined,
    paymentStatus: paymentStatus || undefined,
  }

  const itemsQuery = useQuery({
    queryKey: ['payroll', 'run', id, 'items', filters],
    queryFn: () => getWithMeta<PayrollItem[]>(`/payroll/runs/${id}/items`, filters),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  })

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['payroll'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const calculateMutation = useMutation({
    mutationFn: () => post<CalculationResult>(`/payroll/runs/${id}/calculate`),
    onSuccess: async (response) => {
      setCalculation(response.data)
      toast.success(`Calculated ${response.data.employeesProcessed} employee(s)`)
      await invalidate()
    },
    onError: (error: Error) => toast.error('Calculation failed', error.message),
  })

  const submitMutation = useMutation({
    mutationFn: () => post(`/payroll/runs/${id}/submit-review`),
    onSuccess: async () => {
      toast.success('Submitted for review')
      await invalidate()
    },
    onError: (error: Error) => toast.error('Could not submit', error.message),
  })

  const approveMutation = useMutation({
    mutationFn: () => post(`/payroll/runs/${id}/approve`),
    onSuccess: async () => {
      toast.success('Payroll approved', 'Payments can now be recorded.')
      setConfirm(null)
      await invalidate()
    },
    onError: (error: Error) => {
      setConfirm(null)
      toast.error('Could not approve', error.message)
    },
  })

  const lockMutation = useMutation({
    mutationFn: () => post(`/payroll/runs/${id}/lock`),
    onSuccess: async () => {
      toast.success('Payroll locked')
      setConfirm(null)
      await invalidate()
    },
    onError: (error: Error) => {
      setConfirm(null)
      toast.error('Could not lock', error.message)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => del(`/payroll/runs/${id}`),
    onSuccess: async () => {
      toast.success('Payroll run deleted')
      await invalidate()
      navigate('/payroll')
    },
    onError: (error: Error) => {
      setConfirm(null)
      toast.error('Could not delete the run', error.message)
    },
  })

  const payslipMutation = useMutation({
    mutationFn: () => post<{ generated: number; skipped: number }>(`/payroll/runs/${id}/payslips`),
    onSuccess: (response) => toast.success(`Generated ${response.data.generated} payslip(s)`),
    onError: (error: Error) => toast.error('Could not generate payslips', error.message),
  })

  interface WhatsAppSendSummary {
    sent: number
    skipped: number
    failed: number
    results: { employeeId: string; employeeCode: string; employeeName: string; status: string; detail: string | null }[]
  }

  const sendWhatsAppMutation = useMutation({
    mutationFn: () =>
      post<WhatsAppSendSummary>('/payslips/send-whatsapp', { payrollRunId: id, employeeIds: [...selected] }),
    onSuccess: (response) => {
      setConfirmingWhatsApp(false)
      setSelected(new Set())
      if (response.data.failed > 0 || response.data.skipped > 0) {
        const problems = response.data.results.filter((entry) => entry.status !== 'SENT')
        toast.error(
          response.message ?? 'Some payslips could not be sent',
          problems.slice(0, 5).map((entry) => `${entry.employeeCode}: ${entry.detail ?? entry.status}`).join('; '),
        )
      } else {
        toast.success(response.message ?? 'Payslips sent')
      }
    },
    onError: (error: Error) => {
      setConfirmingWhatsApp(false)
      toast.error('Could not send payslips', error.message)
    },
  })

  const periodMutation = useMutation({
    mutationFn: () => patch<PayrollRun>(`/payroll/runs/${id}/period`, period),
    onSuccess: async (response) => {
      setEditingPeriod(false)
      toast.success(
        'Payroll dates updated',
        response.data.status === 'DRAFT' ? 'Calculate the run again so it uses the new dates.' : undefined,
      )
      await queryClient.invalidateQueries({ queryKey: ['payroll'] })
    },
    onError: (mutationError: Error) => toast.error('Could not change the dates', mutationError.message),
  })

  if (runQuery.isLoading) return <Spinner label="Loading payroll run" />
  if (runQuery.error) return <ErrorState error={runQuery.error} onRetry={() => void runQuery.refetch()} />

  const run = runQuery.data
  if (!run) return null

  const canBulkDownload = can('payslip.view.all') && (run.status === 'APPROVED' || run.status === 'LOCKED')

  const toggleSelected = (employeeId: string, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(employeeId)
      else next.delete(employeeId)
      return next
    })
  }

  const downloadSelected = async (employeeIds: string[], which: 'selected' | 'all'): Promise<void> => {
    setDownloading(which)
    try {
      await downloadPost('/payslips/bulk-download', `payslips-${run.year}-${String(run.month).padStart(2, '0')}.pdf`, {
        payrollRunId: run.id,
        ...(employeeIds.length > 0 ? { employeeIds } : {}),
      })
    } catch (downloadError) {
      toast.error('Could not download payslips', downloadError instanceof Error ? downloadError.message : undefined)
    } finally {
      setDownloading(null)
    }
  }

  const columns: Column<PayrollItem>[] = [
    ...(canBulkDownload
      ? [
          {
            key: 'select',
            header: '',
            render: (row: PayrollItem) => (
              <input
                type="checkbox"
                aria-label={`Select ${row.employeeName}`}
                checked={selected.has(row.employeeId)}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => toggleSelected(row.employeeId, event.target.checked)}
              />
            ),
          },
        ]
      : []),
    {
      key: 'employee',
      header: 'Employee',
      render: (row) => (
        <div>
          <strong>{row.employeeName}</strong>
          <p className="subtle">
            {row.employeeCode}
            {row.departmentName ? ` · ${row.departmentName}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'days',
      header: 'Paid days',
      align: 'right',
      render: (row) => (
        <span>
          {formatDays(row.attendance.paidDays)}
          <span className="subtle"> / {formatDays(row.attendance.payableDaysBasis)}</span>
        </span>
      ),
    },
    { key: 'gross', header: 'Gross', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.grossEarnings) },
    // Deductions are split so PF and ESI can be checked against the returns:
    // the employee's share comes off the pay, the employer's share is on top.
    { key: 'pfEmployee', header: 'PF (employee)', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.contributions?.pfEmployee ?? 0) },
    { key: 'esiEmployee', header: 'ESI (employee)', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.contributions?.esiEmployee ?? 0) },
    { key: 'otherDeductions', header: 'Other deductions', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.contributions?.otherDeductions ?? row.totalDeductions) },
    { key: 'deductions', header: 'Total deductions', align: 'right', render: (row) => formatCurrency(row.totalDeductions) },
    {
      key: 'pfEmployer',
      header: 'PF (employer)',
      align: 'right',
      hideOnMobile: true,
      render: (row) => (
        <span>
          {formatCurrency(row.contributions?.pfEmployer ?? 0)}
          {row.contributions && row.contributions.pfEmployer > 0 ? (
            <span className="subtle" style={{ display: 'block' }}>
              EPF {formatCurrency(row.contributions.pfEmployerEpf)} · EPS {formatCurrency(row.contributions.pfEmployerEps)}
            </span>
          ) : null}
        </span>
      ),
    },
    { key: 'esiEmployer', header: 'ESI (employer)', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.contributions?.esiEmployer ?? 0) },
    { key: 'net', header: 'Net', align: 'right', render: (row) => <strong>{formatCurrency(row.netSalary)}</strong> },
    { key: 'paid', header: 'Paid', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.paidAmount) },
    { key: 'payment', header: 'Payment', render: (row) => <StatusBadge status={row.paymentStatus} /> },
  ]

  const items = itemsQuery.data?.data ?? []
  const meta = itemsQuery.data?.meta

  return (
    <div className="page">
      <PageHeader
        breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: run.monthLabel }]}
        title={`${run.monthLabel} payroll`}
        description={`${formatDate(run.periodStart)} to ${formatDate(run.periodEnd)}`}
        actions={
          <>
            {can('payroll.process') && run.isEditable ? (
              <Button
                variant="secondary"
                icon={<CalendarRange size={15} />}
                onClick={() => {
                  setPeriod({ periodStart: run.periodStart, periodEnd: run.periodEnd })
                  setEditingPeriod(true)
                }}
              >
                Change dates
              </Button>
            ) : null}

            {can('payroll.process') && run.isEditable ? (
              <Button icon={<Calculator size={15} />} loading={calculateMutation.isPending} onClick={() => calculateMutation.mutate()}>
                {run.status === 'DRAFT' ? 'Calculate' : 'Recalculate'}
              </Button>
            ) : null}

            {can('payroll.process') && run.status === 'CALCULATED' ? (
              <Button variant="secondary" icon={<Send size={15} />} loading={submitMutation.isPending} onClick={() => submitMutation.mutate()}>
                Submit for review
              </Button>
            ) : null}

            {can('payroll.approve') && (run.status === 'CALCULATED' || run.status === 'UNDER_REVIEW') ? (
              <Button icon={<BadgeCheck size={15} />} onClick={() => setConfirm('approve')}>
                Approve
              </Button>
            ) : null}

            {can('payroll.lock') && run.status === 'APPROVED' ? (
              <Button variant="secondary" icon={<Lock size={15} />} onClick={() => setConfirm('lock')}>
                Lock
              </Button>
            ) : null}

            {can('payslip.generate') && (run.status === 'APPROVED' || run.status === 'LOCKED') ? (
              <Button variant="secondary" icon={<FileText size={15} />} loading={payslipMutation.isPending} onClick={() => payslipMutation.mutate()}>
                Generate payslips
              </Button>
            ) : null}

            {can('payment.view.all') && (run.status === 'APPROVED' || run.status === 'LOCKED') ? (
              <Button variant="secondary" icon={<Wallet size={15} />} onClick={() => navigate(`/payments?runId=${run.id}`)}>
                Payments
              </Button>
            ) : null}

            {canBulkDownload && selected.size > 0 ? (
              <Button
                variant="secondary"
                icon={<FileText size={15} />}
                loading={downloading === 'selected'}
                onClick={() => void downloadSelected([...selected], 'selected')}
              >
                Download selected ({selected.size})
              </Button>
            ) : null}

            {canBulkDownload && selected.size > 0 ? (
              <Button
                variant="secondary"
                icon={<MessageCircle size={15} />}
                onClick={() => setConfirmingWhatsApp(true)}
              >
                Send via WhatsApp ({selected.size})
              </Button>
            ) : null}

            {canBulkDownload ? (
              <Button
                variant="secondary"
                icon={<FileText size={15} />}
                loading={downloading === 'all'}
                onClick={() => void downloadSelected([], 'all')}
              >
                Download all payslips
              </Button>
            ) : null}

            {can('payroll.delete') && run.status === 'DRAFT' ? (
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setConfirm('delete')}>
                Delete run
              </Button>
            ) : null}

            {can('report.export') ? (
              <Button
                variant="secondary"
                icon={<Download size={15} />}
                onClick={() =>
                  void download('/reports/salary-register/export', `salary-register-${run.year}-${run.month}.xlsx`, {
                    format: 'xlsx',
                    year: run.year,
                    month: run.month,
                  })
                }
              >
                Export
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-4">
        <StatTile label="Status" value={<StatusBadge status={run.status} />} sublabel={run.approvedAt ? `Approved ${formatDateTime(run.approvedAt)}` : undefined} tone="info" />
        <StatTile label="Employees" value={run.totalEmployees} tone="neutral" />
        <StatTile label="Gross" value={formatCurrency(run.totalGross)} sublabel={`Deductions ${formatCurrency(run.totalDeductions)}`} tone="accent" />
        <StatTile label="Net payable" value={formatCurrency(run.totalNet)} sublabel={`${formatCurrency(run.totalPaid)} paid`} tone="success" />
      </div>

      {run.isLocked ? (
        <div className="alert alert-info">
          This run is locked. Salary, attendance and payroll figures for this period can no longer be edited; use a payroll
          adjustment in a later month to correct anything.
        </div>
      ) : null}

      {calculation && calculation.skipped.length > 0 ? (
        <div className="alert alert-warning">
          <strong>{calculation.skipped.length} employee(s) were skipped.</strong>
          <ul style={{ marginTop: '0.4rem' }}>
            {calculation.skipped.slice(0, 5).map((entry) => (
              <li key={entry.employeeId}>
                {entry.employeeCode}: {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {calculation && calculation.warnings.length > 0 ? (
        <div className="alert alert-warning">
          <strong>Review before approving:</strong>
          <ul style={{ marginTop: '0.4rem' }}>
            {calculation.warnings.slice(0, 5).map((entry) => (
              <li key={entry.employeeCode}>
                {entry.employeeCode}: {entry.warnings.join(' ')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card padded={false}>
        <div className="filter-bar">
          <SearchInput value={search} onChange={setSearch} placeholder="Employee name or code" />

          <Field label="Department" htmlFor="run-department">
            <DepartmentSelector id="run-department" value={departmentId} onChange={setDepartmentId} />
          </Field>

          <Field label="Payment status" htmlFor="run-payment-status">
            <Select id="run-payment-status" value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value)}>
              <option value="">All</option>
              <option value="PENDING">Pending</option>
              <option value="PARTIALLY_PAID">Partially paid</option>
              <option value="PAID">Paid</option>
            </Select>
          </Field>
        </div>

        <DataTable
          columns={columns}
          rows={items}
          rowKey={(row) => row.id}
          loading={itemsQuery.isFetching}
          error={itemsQuery.error}
          onRetry={() => void itemsQuery.refetch()}
          onRowClick={(row) => navigate(`/payroll/items/${row.id}`)}
          emptyTitle={run.status === 'DRAFT' ? 'Not calculated yet' : 'No payroll items match these filters'}
          emptyDescription={run.status === 'DRAFT' ? 'Run the calculation to build this payroll.' : undefined}
          caption={`${run.monthLabel} payroll items`}
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

      <Modal
        open={editingPeriod}
        title="Change payroll dates"
        description={
          run.status === 'DRAFT'
            ? 'The days this run covers. Two runs cannot cover the same day.'
            : 'The days this run covers. Changing them sends the run back to draft, and it must be calculated again before it can be reviewed.'
        }
        onClose={() => setEditingPeriod(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditingPeriod(false)}>
              Cancel
            </Button>
            <Button
              loading={periodMutation.isPending}
              disabled={!period.periodStart || !period.periodEnd || period.periodEnd < period.periodStart}
              onClick={() => periodMutation.mutate()}
            >
              Save dates
            </Button>
          </>
        }
      >
        <div className="grid grid-2">
          <Field label="Period starts" htmlFor="period-start" required>
            <Input
              id="period-start"
              type="date"
              value={period.periodStart}
              onChange={(event) => setPeriod({ ...period, periodStart: event.target.value })}
            />
          </Field>
          <Field label="Period ends" htmlFor="period-end" required>
            <Input
              id="period-end"
              type="date"
              value={period.periodEnd}
              onChange={(event) => setPeriod({ ...period, periodEnd: event.target.value })}
            />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirm === 'approve'}
        title="Approve payroll"
        message={
          <>
            <p>
              Approving {run.monthLabel} publishes {formatCurrency(run.totalNet)} across {run.totalEmployees} employee(s).
              Employees will be able to see their own figures, and payments can be recorded.
            </p>
            <p style={{ marginTop: '0.6rem' }}>The run can no longer be recalculated after this.</p>
          </>
        }
        confirmLabel="Approve payroll"
        loading={approveMutation.isPending}
        onConfirm={() => approveMutation.mutate()}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete payroll run"
        message={`This run for ${run.monthLabel} has not been calculated yet. Deleting it removes it permanently - it can be recreated for the same month afterwards.`}
        confirmLabel="Delete run"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === 'lock'}
        title="Lock payroll"
        message="Locking freezes the attendance for this period as well as the payroll figures. Corrections after this must go through a payroll adjustment."
        confirmLabel="Lock payroll"
        loading={lockMutation.isPending}
        onConfirm={() => lockMutation.mutate()}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirmingWhatsApp}
        title="Send payslips via WhatsApp"
        message={`Send the ${run.monthLabel} payslip to ${selected.size} employee${selected.size === 1 ? '' : 's'} over WhatsApp? Anyone without a mobile number on file, or whose message fails to send, will be skipped and reported.`}
        confirmLabel="Send"
        loading={sendWhatsAppMutation.isPending}
        onConfirm={() => sendWhatsAppMutation.mutate()}
        onCancel={() => setConfirmingWhatsApp(false)}
      />
    </div>
  )
}
