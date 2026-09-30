import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { download, request } from '../../lib/api'
import { formatDate, humanise, todayIso } from '../../lib/format'
import { useToast } from '../../app/providers/ToastProvider'
import { Button, Field, Input, Modal, Select, Textarea } from '../ui'
import type { Payout } from '../../types/api'

/**
 * Paying something outside salary - a bonus or a PL Wages credit. It is paid on
 * its own, then marked paid here with the date, how it was paid, a reference and
 * a supporting document; many rows paid together share one document.
 */

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CHEQUE', 'UPI', 'OTHER'] as const

interface MarkPaidModalProps {
  open: boolean
  title: string
  description?: string
  /** The module's API path, e.g. "/bonuses". */
  basePath: string
  ids: string[]
  /** The current details, when correcting a row that is already paid. */
  initial?: Payout | null
  /** Query key prefix to refresh once saved. */
  queryKey: string
  onClose: () => void
  onDone?: () => void
}

export function MarkPaidModal({ open, title, description, basePath, ids, initial, queryKey, onClose, onDone }: MarkPaidModalProps) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const [form, setForm] = useState({ paidOn: todayIso(), paymentMethod: 'BANK_TRANSFER', referenceNumber: '', notes: '' })
  const [file, setFile] = useState<File | null>(null)

  // Each opening starts afresh, or from what is recorded on a paid row.
  useEffect(() => {
    if (!open) return
    setForm({
      paidOn: initial?.paidOn ?? todayIso(),
      paymentMethod: initial?.paymentMethod ?? 'BANK_TRANSFER',
      referenceNumber: initial?.referenceNumber ?? '',
      notes: initial?.paymentNotes ?? '',
    })
    setFile(null)
  }, [open, initial])

  const mutation = useMutation({
    mutationFn: () => {
      const formData = new FormData()
      formData.append('paidOn', form.paidOn)
      formData.append('paymentMethod', form.paymentMethod)
      if (form.referenceNumber.trim()) formData.append('referenceNumber', form.referenceNumber.trim())
      if (form.notes.trim()) formData.append('notes', form.notes.trim())
      if (file) formData.append('file', file)
      if (ids.length === 1) {
        return request(`${basePath}/${ids[0]}/mark-paid`, { method: 'PATCH', formData })
      }
      formData.append('ids', JSON.stringify(ids))
      return request(`${basePath}/mark-paid`, { method: 'POST', formData })
    },
    onSuccess: async (response) => {
      toast.success(response.message ?? 'Marked as paid')
      await queryClient.invalidateQueries({ queryKey: [queryKey] })
      onDone?.()
      onClose()
    },
    onError: (mutationError: Error) => toast.error('Could not mark as paid', mutationError.message),
  })

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={mutation.isPending} disabled={!form.paidOn || ids.length === 0} onClick={() => mutation.mutate()}>
            {initial?.paidOn ? 'Save' : 'Mark as paid'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Paid on" htmlFor="payout-paid-on" required>
            <Input
              id="payout-paid-on"
              type="date"
              value={form.paidOn}
              max={todayIso()}
              onChange={(event) => setForm({ ...form, paidOn: event.target.value })}
            />
          </Field>
          <Field label="Paid by" htmlFor="payout-method" required>
            <Select id="payout-method" value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value })}>
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {method === 'UPI' ? 'UPI' : humanise(method)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Reference number" htmlFor="payout-reference" hint="The UTR, cheque number or voucher number.">
          <Input
            id="payout-reference"
            value={form.referenceNumber}
            maxLength={120}
            onChange={(event) => setForm({ ...form, referenceNumber: event.target.value })}
          />
        </Field>
        <Field
          label="Supporting document"
          htmlFor="payout-proof-file"
          hint={
            initial?.hasProof
              ? `PDF, PNG or JPEG. Leave empty to keep ${initial.proofFilename ?? 'the current document'}.`
              : ids.length > 1
                ? `PDF, PNG or JPEG - a bank statement or signed voucher. One document is kept for all ${ids.length}.`
                : 'PDF, PNG or JPEG - a bank statement, cheque copy or signed voucher.'
          }
        >
          <input
            id="payout-proof-file"
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label="Notes" htmlFor="payout-notes">
          <Textarea
            id="payout-notes"
            rows={2}
            maxLength={300}
            value={form.notes}
            onChange={(event) => setForm({ ...form, notes: event.target.value })}
          />
        </Field>
      </div>
    </Modal>
  )
}

/** When and how a row was paid, with its supporting document to download. */
export function PayoutSummary({ payout, proofPath, proofName }: { payout: Payout; proofPath: string; proofName: string }) {
  const toast = useToast()

  const downloadProof = async (): Promise<void> => {
    try {
      await download(proofPath, payout.proofFilename ?? proofName)
    } catch (downloadError) {
      toast.error('Could not download the document', downloadError instanceof Error ? downloadError.message : undefined)
    }
  }

  const details = [
    payout.paidOn ? formatDate(payout.paidOn) : null,
    payout.paymentMethod ? (payout.paymentMethod === 'UPI' ? 'UPI' : humanise(payout.paymentMethod)) : null,
    payout.referenceNumber,
  ].filter(Boolean)

  return (
    <div>
      {details.length > 0 ? <p className="subtle">{details.join(' · ')}</p> : null}
      {payout.paymentNotes ? <p className="subtle">{payout.paymentNotes}</p> : null}
      {payout.hasProof ? (
        <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => void downloadProof()}>
          Document
        </Button>
      ) : (
        <p className="subtle">No document</p>
      )}
    </div>
  )
}
