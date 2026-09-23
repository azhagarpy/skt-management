import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin from '@fullcalendar/interaction'
import type { DateClickArg } from '@fullcalendar/interaction'
import type { DatesSetArg } from '@fullcalendar/core'
import { Maximize2, Minimize2, Plus, Trash2 } from 'lucide-react'
import { del, get, patch, post } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Tabs,
  Textarea,
} from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { DepartmentSelector, SupervisorSelector } from '../../components/forms/selectors'
import type { Holiday, WeeklyOffCalendar } from '../../types/api'

/**
 * Calendar configuration: holidays, and per-employee weekly off assignments
 * (plan sections 8 and 9).
 */

const WEEKDAY_NAMES_BY_JS_DAY = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const

/** Formats a FullCalendar cell/click Date as a plain ISO date, using its local
 * calendar fields rather than `toISOString()` so no timezone shift occurs. */
function isoDateOf(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function daysBetweenIso(startIso: string, endIsoExclusive: string): number {
  const toUtcDays = (iso: string): number => {
    const [year, month, day] = iso.slice(0, 10).split('-').map(Number)
    return Date.UTC(year, (month ?? 1) - 1, day) / 86_400_000
  }
  return toUtcDays(endIsoExclusive) - toUtcDays(startIso)
}

export default function CalendarPage() {
  const { can } = useAuth()
  const [tab, setTab] = useState('holidays')
  const canAssign = can('weeklyoff.manage') || can('weeklyoff.assign.team')

  const tabs = [
    { key: 'holidays', label: 'Holidays' },
    ...(canAssign ? [{ key: 'weekly-off-assignments', label: 'Employee weekoff assignments' }] : []),
  ]

  return (
    <div className="page">
      <PageHeader
        title="Calendar"
        description="Holidays and weekly offs. Attendance and payroll both read these rules."
      />

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'holidays' ? <HolidaysTab canManage={can('holiday.manage')} /> : null}
      {tab === 'weekly-off-assignments' && canAssign ? <WeeklyOffAssignmentsTab /> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

function HolidaysTab({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const currentYear = new Date().getFullYear()

  const [year, setYear] = useState(currentYear)
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Holiday | null>(null)
  const [form, setForm] = useState({ name: '', holidayDate: '', description: '', isOptional: false, isPaid: true, extraPayIfWorked: false })

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['holidays', year],
    queryFn: () => get<Holiday[]>('/holidays', { year }),
  })

  const createMutation = useMutation({
    mutationFn: () =>
      post('/holidays', {
        name: form.name,
        holidayDate: form.holidayDate,
        description: form.description || null,
        isOptional: form.isOptional,
        isPaid: form.isPaid,
        extraPayIfWorked: form.extraPayIfWorked,
      }),
    onSuccess: async () => {
      toast.success('Holiday added')
      setAdding(false)
      setForm({ name: '', holidayDate: '', description: '', isOptional: false, isPaid: true, extraPayIfWorked: false })
      await queryClient.invalidateQueries({ queryKey: ['holidays'] })
    },
    onError: (mutationError: Error) => toast.error('Could not add the holiday', mutationError.message),
  })

  const extraPayMutation = useMutation({
    mutationFn: (holiday: Holiday) => patch(`/holidays/${holiday.id}`, { extraPayIfWorked: !holiday.extraPayIfWorked }),
    onSuccess: async (_response, holiday) => {
      toast.success(
        holiday.extraPayIfWorked ? 'Extra pay turned off' : 'Extra pay turned on',
        'Recalculate any payroll run that covers this date to apply it.',
      )
      await queryClient.invalidateQueries({ queryKey: ['holidays'] })
    },
    onError: (mutationError: Error) => toast.error('Could not update the holiday', mutationError.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (holiday: Holiday) => del(`/holidays/${holiday.id}`),
    onSuccess: async () => {
      toast.success('Holiday removed')
      setDeleteTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['holidays'] })
    },
    onError: (mutationError: Error) => {
      setDeleteTarget(null)
      toast.error('Could not remove the holiday', mutationError.message)
    },
  })

  const columns: Column<Holiday>[] = [
    { key: 'date', header: 'Date', render: (row) => formatDate(row.holidayDate) },
    { key: 'name', header: 'Holiday', render: (row) => <strong>{row.name}</strong> },
    {
      key: 'type',
      header: 'Type',
      render: (row) => (
        <span style={{ display: 'inline-flex', gap: '0.3rem' }}>
          {row.isOptional ? <Badge tone="neutral">Optional</Badge> : <Badge tone="accent">Company holiday</Badge>}
          {row.isPaid ? null : <Badge tone="warning">Unpaid</Badge>}
          {row.extraPayIfWorked ? <Badge tone="success">Extra pay if worked</Badge> : null}
        </span>
      ),
    },
    { key: 'description', header: 'Description', hideOnMobile: true, render: (row) => row.description ?? <span className="subtle">—</span> },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            render: (row: Holiday) => (
              <span style={{ display: 'inline-flex', gap: '0.25rem' }}>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={extraPayMutation.isPending && extraPayMutation.variables?.id === row.id}
                  onClick={() => extraPayMutation.mutate(row)}
                >
                  {row.extraPayIfWorked ? 'Turn off extra pay' : 'Turn on extra pay'}
                </Button>
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDeleteTarget(row)}>
                  Remove
                </Button>
              </span>
            ),
          },
        ]
      : []),
  ]

  const years = Array.from({ length: 5 }, (_, index) => currentYear - 1 + index)

  return (
    <Card
      title="Holidays"
      description="Holidays appear automatically in attendance and are treated as paid days unless marked otherwise."
      actions={
        <>
          <Select value={year} onChange={(event) => setYear(Number(event.target.value))} aria-label="Year">
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          {canManage ? (
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              Add holiday
            </Button>
          ) : null}
        </>
      }
      padded={false}
    >
      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(row) => row.id}
        loading={isFetching}
        error={error}
        onRetry={() => void refetch()}
        emptyTitle={`No holidays configured for ${year}`}
        emptyDescription="Add the holidays your organization observes."
        caption={`Holidays for ${year}`}
      />

      <Modal
        open={adding}
        title="Add holiday"
        onClose={() => setAdding(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button loading={createMutation.isPending} disabled={!form.name || !form.holidayDate} onClick={() => createMutation.mutate()}>
              Add holiday
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="Name" htmlFor="holiday-name" required>
            <Input id="holiday-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Date" htmlFor="holiday-date" required>
            <Input
              id="holiday-date"
              type="date"
              value={form.holidayDate}
              onChange={(event) => setForm({ ...form, holidayDate: event.target.value })}
            />
          </Field>
          <Field label="Description" htmlFor="holiday-description">
            <Textarea
              id="holiday-description"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </Field>
          <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
            <input type="checkbox" checked={form.isOptional} onChange={(event) => setForm({ ...form, isOptional: event.target.checked })} />
            <span>Optional holiday (employees may choose to work)</span>
          </label>
          <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
            <input type="checkbox" checked={form.isPaid} onChange={(event) => setForm({ ...form, isPaid: event.target.checked })} />
            <span>Paid holiday</span>
          </label>
          <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={form.extraPayIfWorked}
              onChange={(event) => setForm({ ...form, extraPayIfWorked: event.target.checked })}
            />
            <span>Double Pay</span>
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove holiday"
        message={`Remove ${deleteTarget?.name}? Attendance already marked as Holiday on that date is not changed.`}
        confirmLabel="Remove"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  )
}


// ---------------------------------------------------------------------------
// Per-employee weekly off assignments
// ---------------------------------------------------------------------------

interface AssignTarget {
  date: string
  weekday: string
  recurring: boolean
  employeeIds: Set<string>
  /** Who was already off on this date when the modal opened, so unchecking one of them removes their weekly off instead of being silently ignored. */
  initialOffIds: Set<string>
}

interface VisibleRange {
  start: string
  days: number
}

/**
 * A full-screen (or full-width) month calendar for managing who is off which
 * day. Click any day to open the assign panel; each day shows how many of the
 * filtered employees are already off.
 */
function WeeklyOffAssignmentsTab() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const containerRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [range, setRange] = useState<VisibleRange | null>(null)
  const [departmentId, setDepartmentId] = useState('')
  const [supervisorId, setSupervisorId] = useState('')
  const [search, setSearch] = useState('')
  const [target, setTarget] = useState<AssignTarget | null>(null)

  useEffect(() => {
    function handleFullscreenChange(): void {
      setIsFullscreen(document.fullscreenElement === containerRef.current)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const filters = range
    ? {
        weekStart: range.start,
        days: range.days,
        departmentId: departmentId || undefined,
        supervisorId: supervisorId || undefined,
        search: search || undefined,
      }
    : null

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['weekly-off-calendar', filters],
    queryFn: () => get<WeeklyOffCalendar>('/weekly-offs/assignments/calendar', filters ?? {}),
    enabled: filters !== null,
  })

  const assignMutation = useMutation({
    mutationFn: async (values: AssignTarget) => {
      const toAssign = Array.from(values.employeeIds)
      const toRemove = Array.from(values.initialOffIds).filter((id) => !values.employeeIds.has(id))

      if (toAssign.length > 0) {
        await (values.recurring
          ? post('/weekly-offs/assignments', { weekday: values.weekday, effectiveFrom: values.date, employeeIds: toAssign })
          : post('/weekly-offs/assignments/one-off', { offDate: values.date, employeeIds: toAssign }))
      }
      if (toRemove.length > 0) {
        await post('/weekly-offs/assignments/unassign', { date: values.date, employeeIds: toRemove })
      }
    },
    onSuccess: async () => {
      toast.success('Weekly off updated')
      setTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['weekly-off-calendar'] })
    },
    onError: (mutationError: Error) => toast.error('Could not update the weekly off', mutationError.message),
  })

  const employees = useMemo(() => data?.employees ?? [], [data])

  const summaryByDate = useMemo(() => {
    const map = new Map<string, { total: number; off: number; offNames: string[] }>()
    for (const employee of employees) {
      for (const day of employee.days) {
        const entry = map.get(day.date) ?? { total: 0, off: 0, offNames: [] }
        entry.total += 1
        if (day.isWeeklyOff) {
          entry.off += 1
          entry.offNames.push(employee.employeeName)
        }
        map.set(day.date, entry)
      }
    }
    return map
  }, [employees])

  const openAssign = (date: string): void => {
    const weekday = WEEKDAY_NAMES_BY_JS_DAY[new Date(`${date}T00:00:00`).getDay()] ?? 'MONDAY'
    const preselected = new Set(
      employees.filter((employee) => employee.days.find((day) => day.date === date)?.isWeeklyOff).map((employee) => employee.employeeId),
    )
    setTarget({ date, weekday, recurring: false, employeeIds: preselected, initialOffIds: preselected })
  }

  const toggleEmployee = (employeeId: string): void => {
    if (!target) return
    const next = new Set(target.employeeIds)
    if (next.has(employeeId)) next.delete(employeeId)
    else next.add(employeeId)
    setTarget({ ...target, employeeIds: next })
  }

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void containerRef.current?.requestFullscreen()
  }

  return (
    <Card
      title="Employee weekoff assignments"
      description="Click a day to assign specific employees a weekly off. A recurring assignment keeps applying to upcoming weeks until you change it; supervisors can only assign their own team."
      padded={false}
      actions={
        <Button
          size="sm"
          variant="secondary"
          icon={isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? 'Exit full screen' : 'Full screen'}
        </Button>
      }
    >
      <div className="filter-bar">
        <Field label="Department" htmlFor="woa-department">
          <DepartmentSelector id="woa-department" value={departmentId} onChange={setDepartmentId} />
        </Field>
        <Field label="Supervisor" htmlFor="woa-supervisor">
          <SupervisorSelector id="woa-supervisor" value={supervisorId} onChange={setSupervisorId} />
        </Field>
        <Field label="Search" htmlFor="woa-search">
          <Input
            id="woa-search"
            placeholder="Name or employee ID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
      </div>

      {error ? (
        <p className="muted" style={{ padding: '1rem' }}>
          Could not load the calendar.{' '}
          <Button size="sm" variant="ghost" onClick={() => void refetch()}>
            Retry
          </Button>
        </p>
      ) : null}

      <div ref={containerRef} className={`weekoff-calendar${isFullscreen ? ' is-fullscreen' : ''}`}>
        {isFetching ? <p className="muted weekoff-calendar-loading">Loading…</p> : null}
        <FullCalendar
          plugins={[dayGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          firstDay={1}
          height={isFullscreen ? '100%' : 720}
          headerToolbar={{ left: 'prev,next today', center: 'title', right: '' }}
          datesSet={(arg: DatesSetArg) => {
            const start = arg.startStr.slice(0, 10)
            const days = daysBetweenIso(arg.startStr, arg.endStr)
            setRange((current) => (current && current.start === start && current.days === days ? current : { start, days }))
          }}
          dateClick={(arg: DateClickArg) => openAssign(isoDateOf(arg.date))}
          dayCellContent={(arg) => {
            const summary = summaryByDate.get(isoDateOf(arg.date))
            const showNames = summary && summary.off > 0
            return (
              <div className="weekoff-day-cell">
                <span className="weekoff-day-number">{arg.dayNumberText}</span>
                {showNames && summary ? (
                  <span className="weekoff-day-names" title={summary.offNames.join('\n')}>
                    {summary.offNames.slice(0, 3).map((name, index) => (
                      <span key={`${name}-${index}`} className="weekoff-day-name">
                        {name}
                      </span>
                    ))}
                    {summary.offNames.length > 3 ? (
                      <span className="weekoff-day-name weekoff-day-name-more">
                        +{summary.offNames.length - 3} more
                      </span>
                    ) : null}
                  </span>
                ) : summary ? (
                  <span className={`weekoff-day-badge${summary.off > 0 ? ' has-off' : ''}`}>
                    {summary.off}/{summary.total} off
                  </span>
                ) : null}
              </div>
            )
          }}
        />
      </div>

      <Modal
        open={target !== null}
        title={target ? `Assign weekly off — ${formatDate(target.date)}` : ''}
        description="Select employees, then choose whether this becomes their standing weekly off or applies to this week only."
        onClose={() => setTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              loading={assignMutation.isPending}
              disabled={
                !target ||
                (target.employeeIds.size === target.initialOffIds.size &&
                  Array.from(target.employeeIds).every((id) => target.initialOffIds.has(id)))
              }
              onClick={() => target && assignMutation.mutate(target)}
            >
              Save
            </Button>
          </>
        }
      >
        {target ? (
          <div className="stack">
            <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={target.recurring}
                onChange={(event) => setTarget({ ...target, recurring: event.target.checked })}
              />
              <span>Apply to this and every upcoming {target.weekday.charAt(0) + target.weekday.slice(1).toLowerCase()}</span>
            </label>
            {!target.recurring ? (
              <p className="subtle">This grant applies only to {formatDate(target.date)}.</p>
            ) : null}

            {employees.length === 0 ? (
              <p className="muted">No employees match the current filters.</p>
            ) : (
              <div className="stack" style={{ gap: '0.35rem', maxHeight: 320, overflowY: 'auto' }}>
                {employees.map((employee) => (
                  <label key={employee.employeeId} className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={target.employeeIds.has(employee.employeeId)}
                      onChange={() => toggleEmployee(employee.employeeId)}
                    />
                    <span>
                      {employee.employeeName} <span className="subtle">({employee.employeeCode})</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </Card>
  )
}
