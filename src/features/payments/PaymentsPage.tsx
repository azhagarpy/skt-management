import { useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileUp, Paperclip, Wallet, X } from 'lucide-react'
import { download, getWithMeta, upload } from '../../lib/api'
import { formatCurrency, todayIso } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import {
  Button,
  Card,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  StatTile,
  StatusBadge,
} from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { DepartmentSelector } from '../../components/forms/selectors'
import type { PayrollItem, PayrollRun } from '../../types/api'

/**
 * Salary payments (plan sections 29 and 30).
 *
 * Payment state is tracked per payroll item and driven by transactions, so an
 * employee can be part-paid across several instalments and the status follows.
 */
export default function PaymentsPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can } = useAuth()

  const [runId, setRunId] = useState(searchParams.get('runId') ?? '')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [paymentStatus, setPaymentStatus] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulk, setBulk] = useState({ paymentDate: todayIso(), paymentMethod: 'BANK_TRANSFER', referencePrefix: '' })
  // An optional receipt / bank advice, attached to every payment this batch records.
  const [referenceFile, setReferenceFile] = useState<File | null>(null)
  const referenceInput = useRef<HTMLInputElement>(null)

  const runsQuery = useQuery({
    queryKey: ['payroll', 'runs', 'payable'],
    queryFn: () => getWithMeta<PayrollRun[]>('/payroll/runs', { pageSize: 24 }),
  })

  const payableRuns = (runsQuery.data?.data ?? []).filter((run) => run.status === 'APPROVED' || run.status === 'LOCKED')
  const activeRunId = runId || payableRuns[0]?.id || ''
  const activeRun = payableRuns.find((run) => run.id === activeRunId)

  const filters = {
    page,
    pageSize: 25,
    search: search || undefined,
    departmentId: departmentId || undefined,
    paymentStatus: paymentStatus || undefined,
  }

  const itemsQuery = useQuery({
    queryKey: ['payroll', 'run', activeRunId, 'items', filters],
    queryFn: () => getWithMeta<PayrollItem[]>(`/payroll/runs/${activeRunId}/items`, filters),
    enabled: Boolean(activeRunId),
    placeholderData: keepPreviousData,
  })

  const bulkMutation = useMutation({
    mutationFn: () => {
      // Sent as a form so the reference document can travel with it; the list of
      // employees is a JSON string inside the form.
      const form = new FormData()
      form.append('payrollRunId', activeRunId)
      form.append('paymentDate', bulk.paymentDate)
      form.append('paymentMethod', bulk.paymentMethod)
      form.append('payrollItemIds', JSON.stringify([...selected]))
      if (bulk.referencePrefix) form.append('referencePrefix', bulk.referencePrefix)
      if (referenceFile) form.append('file', referenceFile)
      return upload<{ itemsPaid: number; totalAmount: number; skipped: { payrollItemId: string; reason: string }[] }>(
        '/payments/bulk',
        form,
      )
    },
    onSuccess: async (response) => {
      const { itemsPaid, totalAmount, skipped } = response.data
      toast.success(
        `Paid ${itemsPaid} employee(s)`,
        `${formatCurrency(totalAmount)} recorded${skipped.length > 0 ? `; ${skipped.length} skipped` : ''}`,
      )
      setBulkOpen(false)
      setSelected(new Set())
      setReferenceFile(null)
      await queryClient.invalidateQueries({ queryKey: ['payroll'] })
    },
    onError: (error: Error) => toast.error('Could not record payments', error.message),
  })

  const items = itemsQuery.data?.data ?? []
  const meta = itemsQuery.data?.meta

  const toggle = (itemId: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const outstandingItems = items.filter((item) => item.pendingAmount > 0)
  const allOutstandingSelected = outstandingItems.length > 0 && outstandingItems.every((item) => selected.has(item.id))

  const selectedTotal = items
    .filter((item) => selected.has(item.id))
    .reduce((sum, item) => sum + item.pendingAmount, 0)

  const columns: Column<PayrollItem>[] = [
    ...(can('payment.manage')
      ? [
          {
            key: 'select',
            header: '',
            width: '40px',
            render: (row: PayrollItem) => (
              <input
                type="checkbox"
                checked={selected.has(row.id)}
                disabled={row.pendingAmount <= 0}
                aria-label={`Select ${row.employeeName}`}
                onClick={(event) => event.stopPropagation()}
                onChange={() => toggle(row.id)}
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
    { key: 'net', header: 'Net salary', align: 'right', render: (row) => formatCurrency(row.netSalary) },
    { key: 'paid', header: 'Paid', align: 'right', render: (row) => formatCurrency(row.paidAmount) },
    {
      key: 'pending',
      header: 'Pending',
      align: 'right',
      render: (row) => (
        <strong className={row.pendingAmount > 0 ? '' : 'subtle'}>{formatCurrency(row.pendingAmount)}</strong>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.paymentStatus} /> },
  ]

  return (
    <div className="page">
      <PageHeader
        title="Payments"
        description="Record salary payments. Partial payments are supported and the status follows the running total."
        actions={
          <>
            {can('report.export') && activeRun ? (
              <Button
                variant="secondary"
                icon={<Download size={15} />}
                onClick={() =>
                  void download('/reports/payment-status/export', `payment-status-${activeRun.year}-${activeRun.month}.xlsx`, {
                    format: 'xlsx',
                    year: activeRun.year,
                    month: activeRun.month,
                  })
                }
              >
                Export
              </Button>
            ) : null}
            {can('payment.manage') ? (
              <Button icon={<Wallet size={15} />} disabled={selected.size === 0} onClick={() => setBulkOpen(true)}>
                Pay selected ({selected.size})
              </Button>
            ) : null}
          </>
        }
      />

      {payableRuns.length === 0 ? (
        <Card>
          <p className="muted">
            No approved payroll runs yet. Payments can only be recorded once a run has been approved.
          </p>
        </Card>
      ) : (
        <>
          {activeRun ? (
            <div className="grid grid-4">
              <StatTile label="Net payable" value={formatCurrency(activeRun.totalNet)} sublabel={activeRun.monthLabel} tone="accent" />
              <StatTile label="Paid" value={formatCurrency(activeRun.totalPaid)} tone="success" />
              <StatTile label="Pending" value={formatCurrency(activeRun.totalPending)} tone={activeRun.totalPending > 0 ? 'warning' : 'neutral'} />
              <StatTile label="Selected" value={formatCurrency(selectedTotal)} sublabel={`${selected.size} employee(s)`} tone="info" />
            </div>
          ) : null}

          <Card padded={false}>
            <div className="filter-bar">
              <Field label="Payroll run" htmlFor="payment-run">
                <Select
                  id="payment-run"
                  value={activeRunId}
                  onChange={(event) => {
                    setRunId(event.target.value)
                    setSelected(new Set())
                    setPage(1)
                  }}
                >
                  {payableRuns.map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.monthLabel}
                    </option>
                  ))}
                </Select>
              </Field>

              <SearchInput value={search} onChange={setSearch} placeholder="Employee name or code" />

              <Field label="Department" htmlFor="payment-department">
                <DepartmentSelector id="payment-department" value={departmentId} onChange={setDepartmentId} />
              </Field>

              <Field label="Status" htmlFor="payment-status">
                <Select id="payment-status" value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value)}>
                  <option value="">All</option>
                  <option value="PENDING">Pending</option>
                  <option value="PARTIALLY_PAID">Partially paid</option>
                  <option value="PAID">Paid</option>
                </Select>
              </Field>

              {can('payment.manage') && outstandingItems.length > 0 ? (
                <div className="filter-bar-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setSelected(allOutstandingSelected ? new Set() : new Set(outstandingItems.map((item) => item.id)))
                    }
                  >
                    {allOutstandingSelected ? 'Clear selection' : 'Select all outstanding'}
                  </Button>
                </div>
              ) : null}
            </div>

            <DataTable
              columns={columns}
              rows={items}
              rowKey={(row) => row.id}
              loading={itemsQuery.isFetching}
              error={itemsQuery.error}
              onRetry={() => void itemsQuery.refetch()}
              onRowClick={(row) => navigate(`/payroll/items/${row.id}`)}
              emptyTitle="No payroll items match these filters"
              caption="Payments"
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
        </>
      )}

      <Modal
        open={bulkOpen}
        title="Pay selected employees"
        description={`${selected.size} employee(s) · ${formatCurrency(selectedTotal)} outstanding`}
        onClose={() => {
          setBulkOpen(false)
          setReferenceFile(null)
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setBulkOpen(false)
                setReferenceFile(null)
              }}
            >
              Cancel
            </Button>
            <Button loading={bulkMutation.isPending} onClick={() => bulkMutation.mutate()}>
              Record payments
            </Button>
          </>
        }
      >
        <div className="stack">
          <p className="muted">
            Each selected employee will be paid their full outstanding amount. Anyone already paid in full is skipped.
          </p>

          <div className="grid grid-2">
            <Field label="Payment date" htmlFor="bulk-date" required>
              <Input id="bulk-date" type="date" value={bulk.paymentDate} onChange={(event) => setBulk({ ...bulk, paymentDate: event.target.value })} />
            </Field>
            <Field label="Method" htmlFor="bulk-method">
              <Select id="bulk-method" value={bulk.paymentMethod} onChange={(event) => setBulk({ ...bulk, paymentMethod: event.target.value })}>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="UPI">UPI</option>
                <option value="CHEQUE">Cheque</option>
                <option value="CASH">Cash</option>
                <option value="OTHER">Other</option>
              </Select>
            </Field>
          </div>

          <Field label="Reference prefix" htmlFor="bulk-reference" hint="Each payment gets this prefix plus the employee code.">
            <Input
              id="bulk-reference"
              value={bulk.referencePrefix}
              placeholder="e.g. NEFT-2026-09"
              onChange={(event) => setBulk({ ...bulk, referencePrefix: event.target.value })}
            />
          </Field>

          <Field
            label="Reference document"
            htmlFor="bulk-document"
            hint="Optional. A receipt, bank advice or cheque copy (PDF, PNG or JPEG) kept with each payment recorded here."
          >
            <input
              ref={referenceInput}
              id="bulk-document"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
              hidden
              onChange={(event) => setReferenceFile(event.target.files?.[0] ?? null)}
            />
            <div className="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <Button variant="secondary" size="sm" icon={<FileUp size={14} />} onClick={() => referenceInput.current?.click()}>
                {referenceFile ? 'Choose a different file' : 'Attach a document'}
              </Button>
              {referenceFile ? (
                <span className="subtle" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <Paperclip size={13} aria-hidden /> {referenceFile.name}
                  <button
                    type="button"
                    className="modal-close"
                    aria-label="Remove the attached document"
                    onClick={() => {
                      setReferenceFile(null)
                      if (referenceInput.current) referenceInput.current.value = ''
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ) : null}
            </div>
          </Field>
        </div>
      </Modal>
    </div>
  )
}
