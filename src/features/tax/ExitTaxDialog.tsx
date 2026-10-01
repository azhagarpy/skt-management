import { useMutation, useQueryClient } from '@tanstack/react-query'
import { post } from '../../lib/api'
import { formatCurrency, formatDate, formatMonth } from '../../lib/format'
import { useToast } from '../../app/providers/ToastProvider'
import { Button, Modal } from '../../components/ui'

/** GET /tax/exit-deductions/:employeeId - see server/src/modules/tax/tax-on-exit.ts. */
export interface ExitTaxPreview {
  employeeId: string
  employeeName: string
  employmentStatus: string
  exitDate: string
  payrollYear: number
  payrollMonth: number
  payrollStatus: string | null
  payrollOpen: boolean
  periodFrom: string
  periodTo: string
  months: { year: number; month: number; label: string; runStatus: string | null; wages: number }[]
  wagesSoFar: number
  taxSoFar: number
  existing: { id: string; wageBase: number; taxAmount: number } | null
}

/**
 * Offered when an employee is marked as having left: deduct the half-year's
 * P.Tax from their final salary. It is normally deducted after the half-year
 * ends, when a leaver is no longer on the payroll to take it from.
 */
export function ExitTaxDialog({ preview, onDone }: { preview: ExitTaxPreview | null; onDone: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const deduct = useMutation({
    mutationFn: (employeeId: string) => post(`/tax/exit-deductions/${employeeId}`),
    onSuccess: async (response) => {
      toast.success(response.message ?? 'P.Tax will be deducted from the final salary')
      await queryClient.invalidateQueries({ queryKey: ['tax'] })
      onDone()
    },
    onError: (error: Error) => toast.error('Could not set the deduction', error.message),
  })

  if (!preview) return null

  const finalMonth = formatMonth(preview.payrollYear, preview.payrollMonth)
  const halfYear = `${formatDate(preview.periodFrom)} – ${formatDate(preview.periodTo)}`
  const calculated = preview.payrollStatus === 'CALCULATED' || preview.payrollStatus === 'UNDER_REVIEW'

  return (
    <Modal
      open
      title="Deduct P.Tax from the final salary?"
      onClose={() => !deduct.isPending && onDone()}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onDone} disabled={deduct.isPending}>
            {preview.payrollOpen ? 'Not now' : 'Close'}
          </Button>
          {preview.payrollOpen ? (
            <Button loading={deduct.isPending} onClick={() => deduct.mutate(preview.employeeId)}>
              Deduct in {finalMonth}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="stack">
        <p style={{ margin: 0 }}>
          <strong>{preview.employeeName}</strong> leaves on {formatDate(preview.exitDate)}, so their last salary is the{' '}
          <strong>{finalMonth}</strong> payroll. P.Tax for this half-year is normally deducted after it ends, when they
          will no longer be paid.
        </p>

        {preview.payrollOpen ? null : (
          <div className="alert alert-warning">
            The {finalMonth} payroll is already {preview.payrollStatus?.toLowerCase()}, so P.Tax can no longer be added to
            it.
          </div>
        )}

        <div className="data-table-wrapper">
          <table className="data-table">
            <caption className="sr-only">Wages this half-year</caption>
            <thead>
              <tr>
                <th>Month</th>
                <th className="align-right">Wages</th>
              </tr>
            </thead>
            <tbody>
              {preview.months.map((entry) => (
                <tr key={entry.label}>
                  <td data-label="Month">{entry.label}</td>
                  <td data-label="Wages" className="align-right">
                    {entry.runStatus === null ? <span className="subtle">No payroll yet</span> : formatCurrency(entry.wages)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Wages so far</td>
                <td className="align-right">{formatCurrency(preview.wagesSoFar)}</td>
              </tr>
              <tr>
                <td>P.Tax on that</td>
                <td className="align-right">
                  <strong>{formatCurrency(preview.taxSoFar)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
          Payroll works the tax out on the wages for {halfYear} when it calculates {finalMonth}, that month's wages
          included, so the amount deducted can be higher than this.
          {calculated ? ` The ${finalMonth} payroll is already calculated - recalculate it to apply the deduction.` : ''}
        </p>
      </div>
    </Modal>
  )
}
