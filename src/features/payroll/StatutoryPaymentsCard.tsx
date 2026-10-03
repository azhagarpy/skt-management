import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Pencil, Plus, Trash2 } from 'lucide-react'
import { del, download, get, request } from '../../lib/api'
import { formatCurrency, formatDate, todayIso } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Button, Card, ConfirmDialog, Field, Input, Modal, StatusBadge, Textarea } from '../../components/ui'
import type { StatutoryChallan, StatutoryPayments, StatutoryScheme } from '../../types/api'

/**
 * A payroll run's PF and ESI: what the run owes each scheme (the employees'
 * share plus the employer's), and the challans that paid it - as many as it
 * took, each with its proof of payment. A scheme is paid once its challans
 * cover what is due.
 */
export function StatutoryPaymentsCard({ runId }: { runId: string }) {
  const { can } = useAuth()
  const toast = useToast()
  const queryClient = useQueryClient()
  const canManage = can('payment.manage')

  // The challan form: a scheme with no challan is a new one, with one an edit.
  const [editing, setEditing] = useState<{ scheme: StatutoryScheme; challan: StatutoryChallan | null } | null>(null)
  const [removing, setRemoving] = useState<{ scheme: StatutoryScheme; challan: StatutoryChallan } | null>(null)

  const query = useQuery({
    queryKey: ['payroll', 'run', runId, 'statutory-payments'],
    queryFn: () => get<StatutoryPayments>(`/statutory-payments/runs/${runId}`),
  })

  const removeMutation = useMutation({
    mutationFn: (challanId: string) => del(`/statutory-payments/challans/${challanId}`),
    onSuccess: async () => {
      toast.success('Challan removed')
      setRemoving(null)
      await queryClient.invalidateQueries({ queryKey: ['payroll'] })
    },
    onError: (error: Error) => {
      setRemoving(null)
      toast.error('Could not remove the challan', error.message)
    },
  })

  const downloadProof = async (challan: StatutoryChallan): Promise<void> => {
    try {
      await download(`/statutory-payments/challans/${challan.id}/proof`, challan.proofFilename)
    } catch (error) {
      toast.error('Could not download the proof', error instanceof Error ? error.message : undefined)
    }
  }

  const data = query.data
  if (!data) return null

  return (
    <Card
      title="PF & ESI challans"
      description={
        data.isPayable
          ? 'Upload each challan paid for this month, with its proof. A scheme is paid once its challans cover what is due.'
          : 'Challans can be uploaded once this run is approved.'
      }
    >
      <div className="stack" style={{ gap: '1.5rem' }}>
        {data.schemes.map((scheme) => (
          <section key={scheme.scheme} className="stack" style={{ gap: '0.6rem' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div>
                <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <strong>{scheme.scheme}</strong>
                  <span className="subtle">{scheme.label}</span>
                  <StatusBadge status={scheme.status} />
                </div>
                <p className="subtle" style={{ marginTop: '0.25rem' }}>
                  Due {formatCurrency(scheme.totalDue)} (employee {formatCurrency(scheme.employeeShare)} + employer{' '}
                  {formatCurrency(scheme.employerShare)}, {scheme.employees} employee{scheme.employees === 1 ? '' : 's'}) · Paid{' '}
                  {formatCurrency(scheme.totalPaid)} · Balance <strong>{formatCurrency(scheme.balance)}</strong>
                </p>
              </div>
              {canManage && data.isPayable && scheme.status !== 'NOT_DUE' ? (
                <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing({ scheme, challan: null })}>
                  Add challan
                </Button>
              ) : null}
            </div>

            {scheme.challans.length > 0 ? (
              <div className="data-table-wrapper">
                <table className="data-table">
                  <caption className="sr-only">{scheme.scheme} challans</caption>
                  <thead>
                    <tr>
                      <th>Challan / TRRN</th>
                      <th>Paid on</th>
                      <th className="align-right">Amount</th>
                      <th>Notes</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {scheme.challans.map((challan) => (
                      <tr key={challan.id}>
                        <td data-label="Challan / TRRN">
                          <strong>{challan.challanNumber ?? '—'}</strong>
                          {challan.uploadedByName ? <p className="subtle">by {challan.uploadedByName}</p> : null}
                        </td>
                        <td data-label="Paid on">{formatDate(challan.paidOn)}</td>
                        <td data-label="Amount" className="align-right">
                          {formatCurrency(challan.amount)}
                        </td>
                        <td data-label="Notes">
                          <span className="subtle">{challan.notes ?? '—'}</span>
                        </td>
                        <td data-label="" className="align-right">
                          <div className="row" style={{ gap: '0.4rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                            <Button size="sm" variant="secondary" icon={<Download size={13} />} onClick={() => void downloadProof(challan)}>
                              Proof
                            </Button>
                            {canManage && data.isPayable ? (
                              <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing({ scheme, challan })}>
                                Edit
                              </Button>
                            ) : null}
                            {canManage ? (
                              <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setRemoving({ scheme, challan })}>
                                Remove
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">{scheme.status === 'NOT_DUE' ? 'Nothing is due this month.' : 'No challans uploaded yet.'}</p>
            )}
          </section>
        ))}
      </div>

      {editing ? (
        <ChallanModal
          runId={runId}
          monthLabel={data.monthLabel}
          scheme={editing.scheme}
          challan={editing.challan}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title="Remove challan"
        message={
          removing
            ? `${removing.scheme.scheme} challan ${removing.challan.challanNumber ?? ''} for ${formatCurrency(removing.challan.amount)} and its proof will be removed.`
            : ''
        }
        confirmLabel="Remove challan"
        tone="danger"
        loading={removeMutation.isPending}
        onConfirm={() => removing && removeMutation.mutate(removing.challan.id)}
        onCancel={() => setRemoving(null)}
      />
    </Card>
  )
}

function ChallanModal({
  runId,
  monthLabel,
  scheme,
  challan,
  onClose,
}: {
  runId: string
  monthLabel: string
  scheme: StatutoryScheme
  challan: StatutoryChallan | null
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [challanNumber, setChallanNumber] = useState(challan?.challanNumber ?? '')
  const [paidOn, setPaidOn] = useState(challan?.paidOn ?? todayIso())
  // A new challan starts at what is still to pay.
  const [amount, setAmount] = useState(challan ? String(challan.amount) : scheme.balance > 0 ? String(scheme.balance) : '')
  const [notes, setNotes] = useState(challan?.notes ?? '')
  const [file, setFile] = useState<File | null>(null)
  // Remounts the file input to clear it for the next challan.
  const [fileInputKey, setFileInputKey] = useState(0)

  const mutation = useMutation({
    mutationFn: (_next: { addAnother: boolean }) => {
      const formData = new FormData()
      formData.append('challanNumber', challanNumber.trim())
      formData.append('paidOn', paidOn)
      formData.append('amount', amount)
      if (notes.trim()) formData.append('notes', notes.trim())
      if (file) formData.append('file', file)
      return challan
        ? request(`/statutory-payments/challans/${challan.id}`, { method: 'PATCH', formData })
        : request(`/statutory-payments/runs/${runId}/${scheme.scheme}/challans`, { method: 'POST', formData })
    },
    onSuccess: async (_response, next) => {
      toast.success(challan ? 'Challan updated' : `${scheme.scheme} challan ${challanNumber.trim()} recorded`)
      await queryClient.invalidateQueries({ queryKey: ['payroll'] })
      if (!next.addAnother) {
        onClose()
        return
      }
      // Ready for the next challan of the same month; the date usually stays.
      setChallanNumber('')
      setAmount('')
      setNotes('')
      setFile(null)
      setFileInputKey((current) => current + 1)
    },
    onError: (error: Error) => toast.error('Could not save the challan', error.message),
  })

  // The proof is required for a new challan; an edit keeps the one on file unless replaced.
  const canSubmit = challanNumber.trim().length > 0 && Number(amount) > 0 && Boolean(paidOn) && (file !== null || challan !== null)

  return (
    <Modal
      open
      title={challan ? `Edit ${scheme.scheme} challan` : `Add ${scheme.scheme} challan`}
      description={`${scheme.label} for ${monthLabel}: ${formatCurrency(scheme.totalDue)} due, ${formatCurrency(scheme.totalPaid)} paid so far.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {!challan ? (
            <Button
              variant="secondary"
              loading={mutation.isPending && mutation.variables?.addAnother === true}
              disabled={!canSubmit || mutation.isPending}
              onClick={() => mutation.mutate({ addAnother: true })}
            >
              Save and add another
            </Button>
          ) : null}
          <Button
            loading={mutation.isPending && mutation.variables?.addAnother !== true}
            disabled={!canSubmit || mutation.isPending}
            onClick={() => mutation.mutate({ addAnother: false })}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Challan / TRRN number" htmlFor="challan-number" required>
            <Input id="challan-number" value={challanNumber} onChange={(event) => setChallanNumber(event.target.value)} />
          </Field>
          <Field label="Paid on" htmlFor="challan-paid-on" required>
            <Input id="challan-paid-on" type="date" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} />
          </Field>
        </div>
        <Field label="Amount paid" htmlFor="challan-amount" required hint="As on the challan, including any admin charges or interest.">
          <Input
            id="challan-amount"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field
          label="Challan / proof of payment"
          htmlFor="challan-proof"
          required={!challan}
          hint={challan ? `On file: ${challan.proofFilename}. Choose a file only to replace it.` : 'PDF, PNG or JPEG.'}
        >
          <input
            key={fileInputKey}
            id="challan-proof"
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label="Notes" htmlFor="challan-notes">
          <Textarea id="challan-notes" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
