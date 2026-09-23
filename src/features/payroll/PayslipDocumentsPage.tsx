import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { FileDown, FileSignature, ScrollText } from 'lucide-react'
import { download, get } from '../../lib/api'
import { formatCurrency } from '../../lib/format'
import { useToast } from '../../app/providers/ToastProvider'
import { Button, Card, Field, Input, PageHeader, Select, Spinner } from '../../components/ui'
import { EmployeeSelector } from '../../components/forms/selectors'
import type { EmployeeSummary } from '../../types/api'

/**
 * Payslips, No Objection Certificates and Letters of Appointment, downloaded
 * one employee at a time.
 *
 * Payslips come as a single PDF with a page per month over the chosen range;
 * only months whose payroll has been approved are offered. Neither the NOC nor
 * the appointment letter is tied to a month - both are generated from the
 * employee's current record.
 */

interface PayslipMonth {
  year: number
  month: number
  /** YYYY-MM */
  value: string
  monthLabel: string
  netSalary: number
}

export default function PayslipDocumentsPage() {
  const toast = useToast()

  const [employeeId, setEmployeeId] = useState('')
  const [employee, setEmployee] = useState<EmployeeSummary | undefined>()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [purpose, setPurpose] = useState('')
  const [otherInformation, setOtherInformation] = useState('')

  const monthsQuery = useQuery({
    queryKey: ['payslips', 'months', employeeId],
    queryFn: () => get<PayslipMonth[]>('/payslips/months', { employeeId }),
    enabled: Boolean(employeeId),
  })

  // Oldest first, so a range reads left to right.
  const months = useMemo(() => [...(monthsQuery.data ?? [])].reverse(), [monthsQuery.data])

  // A new employee starts on their most recent payslip.
  useEffect(() => {
    const latest = months[months.length - 1]?.value ?? ''
    setFrom(latest)
    setTo(latest)
  }, [months])

  const monthsInRange = months.filter((month) => month.value >= from && month.value <= to)

  const changeFrom = (value: string): void => {
    setFrom(value)
    if (to < value) setTo(value)
  }

  const payslipMutation = useMutation({
    mutationFn: () => {
      const name =
        from === to
          ? `payslip-${employee?.employeeCode ?? 'employee'}-${from}.pdf`
          : `payslips-${employee?.employeeCode ?? 'employee'}-${from}_to_${to}.pdf`
      return download('/payslips/range', name, { employeeId, from, to })
    },
    onError: (error: Error) => toast.error('Could not download the payslips', error.message),
  })

  const nocMutation = useMutation({
    mutationFn: () =>
      download('/noc', `noc-${employee?.employeeCode ?? 'employee'}.pdf`, {
        employeeId,
        purpose: purpose.trim() || undefined,
      }),
    onError: (error: Error) => toast.error('Could not create the certificate', error.message),
  })

  const appointmentMutation = useMutation({
    mutationFn: () =>
      download('/appointment-letter', `appointment-letter-${employee?.employeeCode ?? 'employee'}.pdf`, {
        employeeId,
        otherInformation: otherInformation.trim() || undefined,
      }),
    onError: (error: Error) => toast.error('Could not create the appointment letter', error.message),
  })

  const noMonths = Boolean(employeeId) && !monthsQuery.isLoading && months.length === 0

  return (
    <div className="page">
      <PageHeader
        title="Payslips & letters"
        description="Download an employee's payslips, No Objection Certificate or Letter of Appointment as a PDF."
      />

      <Card title="Employee" description="Choose whose documents to prepare.">
        <Field label="Employee" htmlFor="documents-employee">
          <EmployeeSelector
            id="documents-employee"
            value={employeeId}
            includeFormer
            onChange={(id, selected) => {
              setEmployeeId(id)
              setEmployee(selected)
            }}
          />
        </Field>
      </Card>

      <div className="grid grid-2">
        <Card
          title="Payslips"
          description="One PDF with a page for each month in the range. Only approved payroll months can be chosen."
        >
          {!employeeId ? (
            <p className="muted">Choose an employee first.</p>
          ) : monthsQuery.isLoading ? (
            <Spinner label="Finding payslips" />
          ) : noMonths ? (
            <p className="muted">This employee has no approved payslips yet.</p>
          ) : (
            <div className="stack">
              <div className="grid grid-2">
                <Field label="From month" htmlFor="payslip-from">
                  <Select id="payslip-from" value={from} onChange={(event) => changeFrom(event.target.value)}>
                    {months.map((month) => (
                      <option key={month.value} value={month.value}>
                        {month.monthLabel}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="To month" htmlFor="payslip-to">
                  <Select id="payslip-to" value={to} onChange={(event) => setTo(event.target.value)}>
                    {months
                      .filter((month) => month.value >= from)
                      .map((month) => (
                        <option key={month.value} value={month.value}>
                          {month.monthLabel}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>

              <p className="subtle">
                {monthsInRange.length} payslip{monthsInRange.length === 1 ? '' : 's'} · net{' '}
                {formatCurrency(monthsInRange.reduce((sum, month) => sum + month.netSalary, 0))}
              </p>

              <div>
                <Button
                  icon={<FileDown size={15} />}
                  loading={payslipMutation.isPending}
                  disabled={monthsInRange.length === 0}
                  onClick={() => payslipMutation.mutate()}
                >
                  Download payslips
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card
          title="No Objection Certificate"
          description="A one page certificate on the company letterhead, confirming the employee's employment. It is not tied to any month."
        >
          {!employeeId ? (
            <p className="muted">Choose an employee first.</p>
          ) : (
            <div className="stack">
              <Field
                label="Purpose"
                htmlFor="noc-purpose"
                hint="Optional. Completes the sentence 'issued at the request of the employee for the purpose of ...', for example: availing a bank loan."
              >
                <Input
                  id="noc-purpose"
                  maxLength={200}
                  value={purpose}
                  placeholder="e.g. availing a bank loan"
                  onChange={(event) => setPurpose(event.target.value)}
                />
              </Field>
              <div>
                <Button
                  icon={<ScrollText size={15} />}
                  loading={nocMutation.isPending}
                  onClick={() => nocMutation.mutate()}
                >
                  Download NOC
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card
          title="Letter of Appointment"
          description="The statutory letter under the Code on Social Security, 2020. Its sixteen particulars are filled from the employee's record, so check the profile, Aadhaar, PF and ESI details and the current salary are up to date before issuing it."
        >
          {!employeeId ? (
            <p className="muted">Choose an employee first.</p>
          ) : (
            <div className="stack">
              <Field
                label="Any other information"
                htmlFor="appointment-other"
                hint="Optional. Printed as the last particular of the letter."
              >
                <Input
                  id="appointment-other"
                  maxLength={300}
                  value={otherInformation}
                  placeholder="e.g. subject to a three month probation"
                  onChange={(event) => setOtherInformation(event.target.value)}
                />
              </Field>
              <div>
                <Button
                  icon={<FileSignature size={15} />}
                  loading={appointmentMutation.isPending}
                  onClick={() => appointmentMutation.mutate()}
                >
                  Download appointment letter
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
