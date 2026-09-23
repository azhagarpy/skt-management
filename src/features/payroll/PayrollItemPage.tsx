import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Paperclip, Plus, Undo2 } from 'lucide-react'
import { download, get, post, upload } from '../../lib/api'
import { formatCurrency, formatDate, formatDays, humanise, todayIso } from '../../lib/format'
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
  Select,
  Spinner,
  StatTile,
  StatusBadge,
  Textarea,
} from '../../components/ui'
import type { PaymentLedger, PaymentTransaction, PayrollItemDetail } from '../../types/api'

/**
 * One employee's payroll for one month: the frozen snapshot, plus the payment
 * ledger against it (plan sections 31 and 30).
 */
export default function PayrollItemPage() {
  const { id } = useParams<{ id: string }>()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can } = useAuth()

  const [paying, setPaying] = useState(false)
  const [reverseTarget, setReverseTarget] = useState<PaymentTransaction | null>(null)
  const [payment, setPayment] = useState({
    paymentDate: todayIso(),
    amount: '',
    paymentMethod: 'BANK_TRANSFER',
    referenceNumber: '',
    notes: '',
  })

  const itemQuery = useQuery({
    queryKey: ['payroll', 'item', id],
    queryFn: () => get<PayrollItemDetail>(`/payroll/items/${id}`),
    enabled: Boolean(id),
  })

  const [proofFile, setProofFile] = useState<File | null>(null)
  const canSeePayments = can('payment.view.all') || can('payment.view.self')

  const paymentsQuery = useQuery({
    queryKey: ['payroll', 'item', id, 'payments'],
    queryFn: () => get<PaymentLedger>(`/payroll/${id}/payments`),
    enabled: Boolean(id) && canSeePayments,
  })

  const payMutation = useMutation({
    mutationFn: async () => {
      const created = await post<PaymentTransaction>(`/payroll/${id}/payments`, {
        paymentDate: payment.paymentDate,
        amount: Number(payment.amount),
        paymentMethod: payment.paymentMethod,
        referenceNumber: payment.referenceNumber || null,
        notes: payment.notes || null,
      })

      // The proof is a second request, so a storage failure cannot lose the
      // payment itself. Report it separately rather than failing the whole thing.
      if (proofFile && created.data?.id) {
        const formData = new FormData()
        formData.append('file', proofFile)
        try {
          await upload(`/payments/${created.data.id}/proof`, formData)
        } catch (error) {
          toast.error(
            'The payment was recorded but the proof did not upload',
            error instanceof Error ? error.message : undefined,
          )
        }
      }
      return created
    },
    onSuccess: async () => {
      toast.success('Payment recorded')
      setPaying(false)
      setProofFile(null)
      setPayment({ paymentDate: todayIso(), amount: '', paymentMethod: 'BANK_TRANSFER', referenceNumber: '', notes: '' })
      await queryClient.invalidateQueries({ queryKey: ['payroll'] })
    },
    onError: (error: Error) => toast.error('Could not record the payment', error.message),
  })

  const reverseMutation = useMutation({
    mutationFn: (transaction: PaymentTransaction) =>
      post(`/payments/${transaction.id}/reverse`, { reason: 'Reversed from the payroll item screen' }),
    onSuccess: async () => {
      toast.success('Payment reversed')
      setReverseTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['payroll'] })
    },
    onError: (error: Error) => {
      setReverseTarget(null)
      toast.error('Could not reverse the payment', error.message)
    },
  })

  if (itemQuery.isLoading) return <Spinner label="Loading payslip detail" />
  if (itemQuery.error) return <ErrorState error={itemQuery.error} onRetry={() => void itemQuery.refetch()} />

  const item = itemQuery.data
  if (!item) return null

  const ledger = paymentsQuery.data
  const remaining = item.pendingAmount

  return (
    <div className="page">
      <PageHeader
        breadcrumbs={[
          { label: 'Payroll', to: '/payroll' },
          ...(item.runYear && item.runMonth ? [{ label: `${item.runMonth}/${item.runYear}`, to: `/payroll/runs/${item.payrollRunId}` }] : []),
          { label: item.employeeName },
        ]}
        title={item.employeeName}
        description={`${item.employeeCode}${item.departmentName ? ` · ${item.departmentName}` : ''} · ${humanise(item.salaryBasis)} paid`}
        actions={
          can('payment.manage') && remaining > 0 ? (
            <Button icon={<Plus size={15} />} onClick={() => setPaying(true)}>
              Record payment
            </Button>
          ) : null
        }
      />

      <div className="net-banner">
        <div>
          <p className="stat-label" style={{ color: 'rgba(244,249,247,0.7)' }}>
            Net salary
          </p>
          <p className="net-banner-value">{formatCurrency(item.netSalary)}</p>
        </div>
        <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
          <div>
            <p className="stat-label" style={{ color: 'rgba(244,249,247,0.7)' }}>
              Paid
            </p>
            <p style={{ fontSize: '1.1rem', fontWeight: 600 }}>{formatCurrency(item.paidAmount)}</p>
          </div>
          <div>
            <p className="stat-label" style={{ color: 'rgba(244,249,247,0.7)' }}>
              Pending
            </p>
            <p style={{ fontSize: '1.1rem', fontWeight: 600 }}>{formatCurrency(item.pendingAmount)}</p>
          </div>
          <div>
            <p className="stat-label" style={{ color: 'rgba(244,249,247,0.7)' }}>
              Status
            </p>
            <StatusBadge status={item.paymentStatus} />
          </div>
        </div>
      </div>

      {item.remarks ? <div className="alert alert-warning">{item.remarks}</div> : null}

      <div className="grid grid-4">
        <StatTile label="Paid days" value={formatDays(item.attendance.paidDays)} sublabel={`of ${formatDays(item.attendance.payableDaysBasis)}`} tone="info" />
        <StatTile label="Present" value={formatDays(item.attendance.presentDays)} sublabel={`${formatDays(item.attendance.absentDays)} absent`} tone="success" />
        <StatTile
          label="Leave"
          value={formatDays(item.attendance.leaveDays)}
          sublabel={`${formatDays(item.attendance.paidLeaveDays)} paid · ${formatDays(item.attendance.unpaidLeaveDays)} unpaid`}
          tone="warning"
        />
        <StatTile
          label="Non-working"
          value={formatDays(item.attendance.holidayDays + item.attendance.weeklyOffDays)}
          sublabel={`${formatDays(item.attendance.holidayDays)} holidays · ${formatDays(item.attendance.weeklyOffDays)} weekly offs`}
          tone="neutral"
        />
      </div>

      <Card title="Salary breakdown" description={item.salaryStructureName ? `Structure: ${item.salaryStructureName}` : undefined}>
        <div className="breakdown">
          <div>
            <p className="stat-label">Earnings</p>
            <div className="breakdown-list">
              {item.earnings.map((component) => (
                <div key={component.id} className="breakdown-row">
                  <span>
                    {component.name}
                    {component.source === 'BONUS' ? <Badge tone="accent">Bonus</Badge> : null}
                    {component.source === 'ADJUSTMENT' ? <Badge tone="info">Adjustment</Badge> : null}
                    {component.source === 'HOLIDAY_WORK' || component.source === 'OVERTIME' ? (
                      component.notes ? <span className="subtle" style={{ display: 'block' }}>{component.notes}</span> : null
                    ) : component.fullAmount !== component.amount ? (
                      <span className="subtle"> · prorated from {formatCurrency(component.fullAmount)}</span>
                    ) : null}
                  </span>
                  <span className="numeric">{formatCurrency(component.amount)}</span>
                </div>
              ))}
            </div>
            <div className="breakdown-total">
              <span>Gross earnings</span>
              <span className="numeric">{formatCurrency(item.grossEarnings)}</span>
            </div>
          </div>

          <div>
            <p className="stat-label">Deductions</p>
            <div className="breakdown-list">
              {item.deductions.length === 0 ? (
                <p className="muted">No deductions.</p>
              ) : (
                item.deductions.map((component) => (
                  <div key={component.id} className="breakdown-row">
                    <span>
                      {component.name}
                      {component.source === 'STATUTORY' ? <Badge tone="neutral">Statutory</Badge> : null}
                      {component.percentage !== null ? <span className="subtle"> · {component.percentage}%</span> : null}
                    </span>
                    <span className="numeric">{formatCurrency(component.amount)}</span>
                  </div>
                ))
              )}
            </div>
            <div className="breakdown-total">
              <span>Total deductions</span>
              <span className="numeric">{formatCurrency(item.totalDeductions)}</span>
            </div>
          </div>
        </div>

        {item.employerContributionComponents.length > 0 ? (
          <div style={{ marginTop: '1.5rem' }}>
            <p className="stat-label">Employer contributions</p>
            <p className="subtle" style={{ marginBottom: '0.4rem' }}>
              Paid by the employer; these do not reduce net salary.
            </p>
            <div className="breakdown-list">
              {item.employerContributionComponents.map((component) => (
                <div key={component.id} className="breakdown-row">
                  <span>{component.name}</span>
                  <span className="numeric">{formatCurrency(component.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      {canSeePayments ? (
        <Card title="Payments" description="Salary can be paid in instalments; every payment is recorded separately.">
          {!ledger || ledger.payments.length === 0 ? (
            <p className="muted">No payments recorded yet.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="align-right">Amount</th>
                  <th>Method</th>
                  <th>Transaction ID</th>
                  <th>Proof</th>
                  <th>Recorded by</th>
                  {can('payment.manage') ? <th className="align-right">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {ledger.payments.map((transaction) => (
                  <tr key={transaction.id} style={transaction.isReversed ? { opacity: 0.55 } : undefined}>
                    <td data-label="Date">{formatDate(transaction.paymentDate)}</td>
                    <td data-label="Amount" className="align-right">
                      {formatCurrency(transaction.amount)}
                      {transaction.isReversed ? <Badge tone="danger">Reversed</Badge> : null}
                    </td>
                    <td data-label="Method">{humanise(transaction.paymentMethod)}</td>
                    <td data-label="Transaction ID">{transaction.referenceNumber ?? '—'}</td>
                    <td data-label="Proof">
                      {transaction.hasProof ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void download(`/payments/${transaction.id}/proof`, transaction.proofFilename ?? 'proof')
                          }
                        >
                          Download
                        </Button>
                      ) : (
                        <span className="subtle">—</span>
                      )}
                    </td>
                    <td data-label="Recorded by">{transaction.createdByName ?? '—'}</td>
                    {can('payment.manage') ? (
                      <td data-label="Actions" className="align-right">
                        {transaction.isReversed ? (
                          <span className="subtle">{transaction.reversalReason}</span>
                        ) : (
                          <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} onClick={() => setReverseTarget(transaction)}>
                            Reverse
                          </Button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      <Modal
        open={paying}
        title="Record a payment"
        description={`Remaining to pay: ${formatCurrency(remaining)}`}
        onClose={() => setPaying(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPaying(false)}>
              Cancel
            </Button>
            <Button
              loading={payMutation.isPending}
              disabled={!payment.amount || Number(payment.amount) <= 0 || Number(payment.amount) > remaining}
              onClick={() => payMutation.mutate()}
            >
              Record payment
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field
            label="Amount"
            htmlFor="payment-amount"
            required
            error={
              payment.amount && Number(payment.amount) > remaining
                ? `The payment cannot exceed the remaining ${formatCurrency(remaining)}`
                : undefined
            }
          >
            <Input
              id="payment-amount"
              type="number"
              step="0.01"
              min="0.01"
              max={remaining}
              value={payment.amount}
              onChange={(event) => setPayment({ ...payment, amount: event.target.value })}
            />
          </Field>

          <Button variant="ghost" size="sm" onClick={() => setPayment({ ...payment, amount: String(remaining) })}>
            Pay the full remaining amount
          </Button>

          <div className="grid grid-2">
            <Field label="Payment date" htmlFor="payment-date" required>
              <Input
                id="payment-date"
                type="date"
                value={payment.paymentDate}
                onChange={(event) => setPayment({ ...payment, paymentDate: event.target.value })}
              />
            </Field>

            <Field label="Method" htmlFor="payment-method">
              <Select
                id="payment-method"
                value={payment.paymentMethod}
                onChange={(event) => setPayment({ ...payment, paymentMethod: event.target.value })}
              >
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="UPI">UPI</option>
                <option value="CHEQUE">Cheque</option>
                <option value="CASH">Cash</option>
                <option value="OTHER">Other</option>
              </Select>
            </Field>
          </div>

          <Field
            label="Transaction ID"
            htmlFor="payment-reference"
            hint={
              payment.paymentMethod === 'CASH'
                ? 'Cash has no bank reference — use a voucher or receipt number, and attach the receipt below.'
                : 'UTR, UPI reference or cheque number. Must be unique within the organization.'
            }
          >
            <Input
              id="payment-reference"
              value={payment.referenceNumber}
              onChange={(event) => setPayment({ ...payment, referenceNumber: event.target.value })}
            />
          </Field>

          <Field
            label="Proof of payment"
            hint="Optional. PDF, PNG or JPEG up to 10 MB — attached after the payment is recorded."
          >
            <label className="file-input">
              <Paperclip size={14} aria-hidden />
              <span>{proofFile ? proofFile.name : 'Choose a receipt or screenshot'}</span>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={(event) => setProofFile(event.target.files?.[0] ?? null)}
              />
            </label>
          </Field>

          <Field label="Notes" htmlFor="payment-notes">
            <Textarea id="payment-notes" value={payment.notes} onChange={(event) => setPayment({ ...payment, notes: event.target.value })} />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={reverseTarget !== null}
        title="Reverse payment"
        message={`Reverse the payment of ${reverseTarget ? formatCurrency(reverseTarget.amount) : ''}? The transaction is kept in the history and marked as reversed.`}
        confirmLabel="Reverse payment"
        tone="danger"
        loading={reverseMutation.isPending}
        onConfirm={() => reverseTarget && reverseMutation.mutate(reverseTarget)}
        onCancel={() => setReverseTarget(null)}
      />
    </div>
  )
}
