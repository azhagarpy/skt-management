import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { del, get, post } from '../../lib/api'
import { formatDate, todayIso } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Badge, Button, Card, Field, Input, PageHeader, Textarea } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { EmployeeSelector } from '../../components/forms/selectors'
import type { OvertimeEntry, OvertimeWeekSummary } from '../../types/api'

/**
 * Overtime entry.
 *
 * Supply employees never see OT as money here - every 8 hours accumulated in a
 * week converts to one extra weekly off (capped at 2/week), shown as a running
 * indicator as hours are entered. PSR employees are paid for OT instead, in the
 * next payroll run, at whatever rate is configured for them.
 */
export default function OvertimePage() {
  const { can } = useAuth()
  const toast = useToast()
  const queryClient = useQueryClient()
  const canManage = can('overtime.manage.all') || can('overtime.manage.team')

  const [from, setFrom] = useState(() => todayIso().slice(0, 8) + '01')
  const [to, setTo] = useState(todayIso())
  const [employeeId, setEmployeeId] = useState('')
  const [form, setForm] = useState({ employeeId: '', workDate: todayIso(), hours: '', remarks: '' })

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

  const saveMutation = useMutation({
    mutationFn: () =>
      post('/overtime', {
        employeeId: form.employeeId,
        workDate: form.workDate,
        hours: Number(form.hours),
        remarks: form.remarks || null,
      }),
    onSuccess: async () => {
      toast.success('Overtime recorded')
      setForm({ employeeId: form.employeeId, workDate: form.workDate, hours: '', remarks: '' })
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
        description="Supply employees convert OT into extra weekly offs automatically; PSR employees are paid for it in payroll."
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
          ) : form.employeeId ? (
            <p className="subtle" style={{ marginTop: '0.75rem' }}>
              This employee is paid for overtime in payroll rather than earning extra weekly offs.
            </p>
          ) : null}

          <div className="row" style={{ marginTop: '0.75rem' }}>
            <Button
              icon={<Plus size={15} />}
              loading={saveMutation.isPending}
              disabled={!form.employeeId || !form.workDate || !form.hours}
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
