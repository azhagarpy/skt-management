import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, Download, Pencil, Undo2 } from 'lucide-react'
import { del, download, get, request } from '../../lib/api'
import { formatCurrency, formatDate, todayIso } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Button, Card, ConfirmDialog, Field, Input, Modal, StatusBadge, Textarea } from '../../components/ui'
import type { StatutoryPayments, StatutoryScheme } from '../../types/api'

/**
 * A payroll run's PF and ESI remittance: what the run owes each scheme (the
 * employees' share plus the employer's), and the challan paid for it with its
 * proof of payment.
 */
export function StatutoryPaymentsCard({ runId }: { runId: string }) {
  const { can } = useAuth()
  const toast = useToast()
  const queryClient = useQueryClient()
  const canManage = can('payment.manage')

  const [editing, setEditing] = useState<StatutoryScheme | null>(null)
  const [undoing, setUndoing] = useState<StatutoryScheme | null>(null)

  const query = useQuery({
    queryKey: ['payroll', 'run', runId, 'statutory-payments'],
    queryFn: () => get<StatutoryPayments>(`/statutory-payments/runs/${runId}`),
  })

  const undoMutation = useMutation({
    mutationFn: (scheme: StatutoryScheme['scheme']) => del(`/statutory-payments/runs/${runId}/${scheme}`),
    onSuccess: async (_response, scheme) => {
      toast.success(`${scheme} marked as unpaid`)
      setUndoing(null)
      await queryClient.invalidateQueries({ queryKey: ['payroll'] })
    },
    onError: (error: Error) => {
      setUndoing(null)
      toast.error('Could not mark as unpaid', error.message)
    },
  })

  const downloadProof = async (scheme: StatutoryScheme): Promise<void> => {
    try {
      await download(`/statutory-payments/runs/${runId}/${scheme.scheme}/proof`, scheme.payment?.proofFilename ?? `${scheme.scheme}-proof`)
    } catch (error) {
      toast.error('Could not download the proof', error instanceof Error ? error.message : undefined)
    }
  }

  const data = query.data
  if (!data) return null

  return (
    <Card
      title="PF & ESI payments"
      description={
        data.isPayable
          ? 'Mark each scheme paid once its challan is paid, with the proof of payment.'
          : 'PF and ESI can be marked paid once this run is approved.'
      }
      padded={false}
    >
      <div className="data-table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Scheme</th>
              <th className="align-right">Employees</th>
              <th className="align-right">Employee share</th>
              <th className="align-right">Employer share</th>
              <th className="align-right">Total due</th>
              <th>Status</th>
              <th>Payment</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.schemes.map((scheme) => (
              <tr key={scheme.scheme}>
                <td data-label="Scheme">
                  <strong>{scheme.scheme}</strong>
                </td>
                <td data-label="Employees" className="align-right">
                  {scheme.employees}
                </td>
                <td data-label="Employee share" className="align-right">
                  {formatCurrency(scheme.employeeShare)}
                </td>
                <td data-label="Employer share" className="align-right">
                  {formatCurrency(scheme.employerShare)}
                </td>
                <td data-label="Total due" className="align-right">
                  <strong>{formatCurrency(scheme.totalDue)}</strong>
                </td>
                <td data-label="Status">
                  <StatusBadge status={scheme.status} />
                </td>
                <td data-label="Payment">
                  {scheme.payment ? (
                    <div>
                      {formatCurrency(scheme.payment.amount)} on {formatDate(scheme.payment.paidOn)}
                      <p className="subtle">
                        {scheme.payment.referenceNumber ? `Ref ${scheme.payment.referenceNumber}` : 'No reference'}
                        {scheme.payment.paidByName ? ` · by ${scheme.payment.paidByName}` : ''}
                      </p>
                    </div>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td data-label="" className="align-right">
                  <div className="row" style={{ gap: '0.4rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    {scheme.payment ? (
                      <Button size="sm" variant="secondary" icon={<Download size={13} />} onClick={() => void downloadProof(scheme)}>
                        Proof
                      </Button>
                    ) : null}
                    {canManage && data.isPayable && scheme.status === 'PENDING' ? (
                      <Button size="sm" icon={<BadgeCheck size={13} />} onClick={() => setEditing(scheme)}>
                        Mark as paid
                      </Button>
                    ) : null}
                    {canManage && scheme.payment ? (
                      <>
                        <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing(scheme)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} onClick={() => setUndoing(scheme)}>
                          Mark unpaid
                        </Button>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing ? (
        <MarkPaidModal runId={runId} monthLabel={data.monthLabel} scheme={editing} onClose={() => setEditing(null)} />
      ) : null}

      <ConfirmDialog
        open={undoing !== null}
        title={`Mark ${undoing?.scheme ?? ''} as unpaid`}
        message={`The ${data.monthLabel} ${undoing?.scheme ?? ''} payment and its proof will be removed, and the scheme shows as pending again.`}
        confirmLabel="Mark unpaid"
        tone="danger"
        loading={undoMutation.isPending}
        onConfirm={() => undoing && undoMutation.mutate(undoing.scheme)}
        onCancel={() => setUndoing(null)}
      />
    </Card>
  )
}

function MarkPaidModal({
  runId,
  monthLabel,
  scheme,
  onClose,
}: {
  runId: string
  monthLabel: string
  scheme: StatutoryScheme
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const existing = scheme.payment
  const [amount, setAmount] = useState(String(existing?.amount ?? scheme.totalDue))
  const [paidOn, setPaidOn] = useState(existing?.paidOn ?? todayIso())
  const [referenceNumber, setReferenceNumber] = useState(existing?.referenceNumber ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [file, setFile] = useState<File | null>(null)

  const mutation = useMutation({
    mutationFn: () => {
      const formData = new FormData()
      formData.append('amount', amount)
      formData.append('paidOn', paidOn)
      if (referenceNumber.trim()) formData.append('referenceNumber', referenceNumber.trim())
      if (notes.trim()) formData.append('notes', notes.trim())
      if (file) formData.append('file', file)
      return request(`/statutory-payments/runs/${runId}/${scheme.scheme}`, { method: 'PUT', formData })
    },
    onSuccess: async () => {
      toast.success(`${scheme.scheme} marked as paid`)
      await queryClient.invalidateQueries({ queryKey: ['payroll'] })
      onClose()
    },
    onError: (error: Error) => toast.error('Could not save the payment', error.message),
  })

  // The proof is required the first time; when editing, the one on file is kept unless replaced.
  const canSubmit = Number(amount) > 0 && Boolean(paidOn) && (file !== null || existing !== null)

  return (
    <Modal
      open
      title={existing ? `Edit ${scheme.scheme} payment` : `Mark ${scheme.scheme} as paid`}
      description={`${scheme.label} for ${monthLabel}: ${formatCurrency(scheme.totalDue)} due (employee ${formatCurrency(scheme.employeeShare)} + employer ${formatCurrency(scheme.employerShare)}).`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={mutation.isPending} disabled={!canSubmit} onClick={() => mutation.mutate()}>
            {existing ? 'Save' : 'Mark as paid'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Amount paid" htmlFor="statutory-amount" required hint="Include any admin charges or interest paid with the challan.">
            <Input
              id="statutory-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>
          <Field label="Paid on" htmlFor="statutory-paid-on" required>
            <Input id="statutory-paid-on" type="date" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} />
          </Field>
        </div>
        <Field label="Challan / TRRN number" htmlFor="statutory-reference">
          <Input id="statutory-reference" value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} />
        </Field>
        <Field
          label="Proof of payment"
          htmlFor="statutory-proof"
          required={!existing}
          hint={existing ? `On file: ${existing.proofFilename}. Choose a file only to replace it.` : 'The challan receipt or bank advice - PDF, PNG or JPEG.'}
        >
          <input
            id="statutory-proof"
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label="Notes" htmlFor="statutory-notes">
          <Textarea id="statutory-notes" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
