import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { del, get, post } from '../../lib/api'
import { formatCurrency, formatDate, todayIso } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Badge, Button, Card, Field, Input, PageHeader, Select, Textarea } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { EmployeeSelector } from '../../components/forms/selectors'
import type { OvertimeEmployeeSettings, OvertimeEntry, OvertimeRateBasis, OvertimeWeekSummary } from '../../types/api'

/**
 * Overtime entry.
 *
 * Supply employees never see OT as money here - every 8 hours accumulated in a
 * week converts to one extra weekly off (capped at 2/week), shown as a running
 * indicator as hours are entered. PSR employees are paid for OT instead, in the
 * next payroll run, at the rate chosen on each entry: one day's salary / n
 * hours, or a custom amount per hour.
 */

/** "Day's salary ÷ 8" or "₹100.00/hour", for the list. */
function describeRate(entry: OvertimeEntry): string {
  if (entry.overtimeHandling === 'OFF_IN_LIEU') return 'Extra weekly off'
  return entry.rateBasis === 'CUSTOM' ? `${formatCurrency(entry.ratePerHour)}/hour` : `Day's salary ÷ ${entry.dayDivisor}`
}
export default function OvertimePage() {
  const { can } = useAuth()
  const toast = useToast()
  const queryClient = useQueryClient()
  const canManage = can('overtime.manage.all') || can('overtime.manage.team')

  const [from, setFrom] = useState(() => todayIso().slice(0, 8) + '01')
  const [to, setTo] = useState(todayIso())
  const [employeeId, setEmployeeId] = useState('')
  const [form, setForm] = useState({
    employeeId: '',
    workDate: todayIso(),
    hours: '',
    remarks: '',
    rateBasis: 'DAY_SALARY' as OvertimeRateBasis,
    dayDivisor: '8',
    ratePerHour: '',
  })

  const listFilters = { from, to, employeeId: employeeId || undefined }
  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['overtime', listFilters],
    queryFn: () => get<OvertimeEntry[]>('/overtime', listFilters),
  })

  const { data: weekSummary } = useQuery({
    queryKey: ['overtime-week-summary', form.employeeId, form.workDate],
    queryFn: () => get<OvertimeWeekSummary | null>('/overtime/week-summary', { employeeId: form.employeeId, date: form.workDate }),
    enabled: Boolean(form.employeeId && form.workDate),
  })

  const { data: employeeSettings } = useQuery({
    queryKey: ['overtime-employee-settings', form.employeeId, form.workDate],
    queryFn: () =>
      get<OvertimeEmployeeSettings>('/overtime/employee-settings', { employeeId: form.employeeId, date: form.workDate }),
    enabled: Boolean(form.employeeId && form.workDate),
  })
  const isPaidHourly = employeeSettings?.overtimeHandling === 'PAID_HOURLY'
  // The rate inputs show from the start, and go only once the chosen employee
  // turns out to be one whose OT becomes extra weekly offs rather than money.
  const showRate = employeeSettings?.overtimeHandling !== 'OFF_IN_LIEU'

  // Start each employee's entries at their default rate; the rate then stays as
  // chosen across entries - and date changes - until another employee is picked.
  const prefilledFor = useRef('')
  useEffect(() => {
    if (!employeeSettings || prefilledFor.current === form.employeeId) return
    prefilledFor.current = form.employeeId
    setForm((current) => ({
      ...current,
      rateBasis: employeeSettings.rateBasis,
      dayDivisor: String(employeeSettings.dayDivisor ?? 8),
      ratePerHour: employeeSettings.ratePerHour === null ? '' : String(employeeSettings.ratePerHour),
    }))
  }, [employeeSettings, form.employeeId])

  // What the entry will be paid, worked out the way payroll does: hours x one
  // day's salary / n in one step, or hours x the custom amount, in paise.
  const hours = Number(form.hours)
  const dayDivisor = Number(form.dayDivisor)
  const daySalary = employeeSettings?.daySalary ?? null
  let overtimeAmount: number | null = null
  if (hours > 0) {
    if (form.rateBasis === 'CUSTOM') {
      if (form.ratePerHour !== '') overtimeAmount = Math.round(Math.round(Number(form.ratePerHour) * 100) * hours) / 100
    } else if (daySalary !== null && dayDivisor > 0) {
      overtimeAmount = Math.round(Math.round(daySalary * 100) * (hours / dayDivisor)) / 100
    }
  }

  const rateMissing =
    showRate && (form.rateBasis === 'CUSTOM' ? form.ratePerHour === '' : !(Number(form.dayDivisor) > 0))

  const saveMutation = useMutation({
    mutationFn: () =>
      post('/overtime', {
        employeeId: form.employeeId,
        workDate: form.workDate,
        hours: Number(form.hours),
        remarks: form.remarks || null,
        ...(!showRate
          ? {}
          : form.rateBasis === 'CUSTOM'
            ? { rateBasis: 'CUSTOM', ratePerHour: Number(form.ratePerHour) }
            : { rateBasis: 'DAY_SALARY', dayDivisor: Number(form.dayDivisor) }),
      }),
    onSuccess: async () => {
      toast.success('Overtime recorded')
      setForm({ ...form, hours: '', remarks: '' })
      await queryClient.invalidateQueries({ queryKey: ['overtime'] })
      await queryClient.invalidateQueries({ queryKey: ['overtime-week-summary'] })
    },
    onError: (mutationError: Error) => toast.error('Could not record overtime', mutationError.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (entry: OvertimeEntry) => del(`/overtime/${entry.id}`),
    onSuccess: async () => {
      toast.success('Overtime entry removed')
      await queryClient.invalidateQueries({ queryKey: ['overtime'] })
      await queryClient.invalidateQueries({ queryKey: ['overtime-week-summary'] })
    },
    onError: (mutationError: Error) => toast.error('Could not remove the entry', mutationError.message),
  })

  const columns: Column<OvertimeEntry>[] = [
    { key: 'date', header: 'Date', render: (row) => formatDate(row.workDate) },
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
    { key: 'hours', header: 'Hours', align: 'right', render: (row) => <span className="numeric">{row.hours}</span> },
    { key: 'rate', header: 'Paid at', hideOnMobile: true, render: (row) => describeRate(row) },
    { key: 'remarks', header: 'Remarks', hideOnMobile: true, render: (row) => row.remarks ?? <span className="subtle">—</span> },
    { key: 'status', header: '', render: (row) => (row.isLocked ? <Badge tone="accent">Locked</Badge> : null) },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            render: (row: OvertimeEntry) =>
              row.isLocked ? null : (
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => deleteMutation.mutate(row)} />
              ),
          },
        ]
      : []),
  ]

  return (
    <div className="page">
      <PageHeader
        title="Overtime"
        description="Supply employees convert OT into extra weekly offs automatically; PSR employees are paid for it in payroll, at the rate chosen on each entry."
      />

      {canManage ? (
        <Card title="Record overtime">
          <div className="grid grid-2">
            <Field label="Employee" htmlFor="ot-employee" required>
              <EmployeeSelector id="ot-employee" value={form.employeeId} onChange={(value) => setForm({ ...form, employeeId: value })} />
            </Field>
            <Field label="Date" htmlFor="ot-date" required>
              <Input id="ot-date" type="date" value={form.workDate} onChange={(event) => setForm({ ...form, workDate: event.target.value })} />
            </Field>
            <Field label="Hours" htmlFor="ot-hours" required hint="Up to 24 hours for the day.">
              <Input
                id="ot-hours"
                type="number"
                step="0.5"
                min="0.5"
                max="24"
                value={form.hours}
                onChange={(event) => setForm({ ...form, hours: event.target.value })}
              />
            </Field>
            {showRate ? (
              <>
                <Field
                  label="Pay per hour"
                  htmlFor="ot-rate-basis"
                  required
                  hint={employeeSettings ? undefined : 'Not used for Supply employees - their OT becomes extra weekly offs.'}
                >
                  <Select
                    id="ot-rate-basis"
                    value={form.rateBasis}
                    onChange={(event) => setForm({ ...form, rateBasis: event.target.value as OvertimeRateBasis })}
                  >
                    <option value="DAY_SALARY">One day's salary ÷ n hours</option>
                    <option value="CUSTOM">Custom amount per hour</option>
                  </Select>
                </Field>
                {form.rateBasis === 'DAY_SALARY' ? (
                  <Field
                    label="n (hours to divide the day's salary by)"
                    htmlFor="ot-day-divisor"
                    required
                    hint={`Each overtime hour pays one day's salary ÷ ${Number(form.dayDivisor) > 0 ? form.dayDivisor : 'n'}.`}
                  >
                    <Input
                      id="ot-day-divisor"
                      type="number"
                      step="0.5"
                      min="0.5"
                      max="24"
                      value={form.dayDivisor}
                      onChange={(event) => setForm({ ...form, dayDivisor: event.target.value })}
                    />
                  </Field>
                ) : (
                  <Field label="Amount per hour (₹)" htmlFor="ot-rate-per-hour" required>
                    <Input
                      id="ot-rate-per-hour"
                      type="number"
                      step="0.01"
                      min="0"
                      value={form.ratePerHour}
                      onChange={(event) => setForm({ ...form, ratePerHour: event.target.value })}
                    />
                  </Field>
                )}
              </>
            ) : null}
            <Field label="Remarks" htmlFor="ot-remarks">
              <Textarea id="ot-remarks" value={form.remarks} onChange={(event) => setForm({ ...form, remarks: event.target.value })} />
            </Field>
          </div>

          {weekSummary ? (
            <div className="alert alert-info" style={{ marginTop: '0.75rem' }}>
              This week ({formatDate(weekSummary.weekStart)}–{formatDate(weekSummary.weekEnd)}): {weekSummary.totalHours} hour(s)
              logged → {weekSummary.extraOffsEarned} extra weekly off(s) earned
              {weekSummary.offDates.length > 0 ? ` (${weekSummary.offDates.map((date) => formatDate(date)).join(', ')})` : ''}.
              {weekSummary.warnings.map((warning) => (
                <p key={warning} className="subtle" style={{ marginTop: '0.3rem' }}>
                  {warning}
                </p>
              ))}
            </div>
          ) : isPaidHourly ? (
            <div className="alert alert-info" style={{ marginTop: '0.75rem' }}>
              {overtimeAmount !== null ? (
                <>
                  <strong>Overtime amount: {formatCurrency(overtimeAmount)}</strong>
                  {' — '}
                  {form.rateBasis === 'CUSTOM'
                    ? `${hours} hour(s) × ${formatCurrency(Number(form.ratePerHour))}`
                    : `${hours} hour(s) × one day's salary ${formatCurrency(daySalary)} ÷ ${dayDivisor}`}
                </>
              ) : form.rateBasis === 'DAY_SALARY' && daySalary === null ? (
                'No salary structure is assigned to this employee for this date, so the amount cannot be worked out yet.'
              ) : (
                'Enter the hours and the rate to see the overtime amount.'
              )}
              <p className="subtle" style={{ marginTop: '0.3rem' }}>
                Added to that month's net salary in payroll, with no PF or ESI deducted from it.
              </p>
            </div>
          ) : null}

          <div className="row" style={{ marginTop: '0.75rem' }}>
            <Button
              icon={<Plus size={15} />}
              loading={saveMutation.isPending}
              disabled={!form.employeeId || !form.workDate || !form.hours || rateMissing}
              onClick={() => saveMutation.mutate()}
            >
              Save
            </Button>
          </div>
        </Card>
      ) : null}

      <Card padded={false}>
        <div className="filter-bar">
          <Field label="From" htmlFor="ot-from">
            <Input id="ot-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="To" htmlFor="ot-to">
            <Input id="ot-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <Field label="Employee" htmlFor="ot-filter-employee">
            <EmployeeSelector id="ot-filter-employee" value={employeeId} onChange={setEmployeeId} />
          </Field>
        </div>

        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          emptyTitle="No overtime recorded"
          emptyDescription="Overtime entries for the selected range will appear here."
          caption="Overtime entries"
        />
      </Card>
    </div>
  )
}
