import { useMemo, useState, type ReactNode } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Lock, Palmtree, Pencil, X } from 'lucide-react'
import { get, patch, post } from '../../lib/api'
import { MONTH_NAMES, todayIso } from '../../lib/format'
import { useToast } from '../../app/providers/ToastProvider'
import { Avatar, Button, ErrorState, Field, Modal, SearchInput, Select, Spinner, Tabs, Textarea } from '../../components/ui'
import { DepartmentSelector, EmployeeSelector, SupervisorSelector, useLeaveTypes } from '../../components/forms/selectors'
import type { AttendanceCalendar, AttendanceCalendarDay, AttendanceStatus, CalendarStatus } from '../../types/api'

/**
 * The attendance calendar: a month or a week at a glance.
 *
 * For a team, each day shows its attendance rate and a bar of how the team
 * split between present, absent, leave and days off; clicking a day lists who.
 * When the view narrows to one employee - picked in the filter, or from a
 * day's list - each day shows that person's status as a coloured circle, and
 * anyone who can mark attendance can click a day to change it.
 *
 * One request per period (`GET /attendance/calendar`) carries every
 * employee's status for every day, so switching between the grid and a day's
 * names needs no further round trips.
 */

type Mode = 'month' | 'week'
type CalendarEmployee = AttendanceCalendar['employees'][number]
type Counts = AttendanceCalendarDay['counts']
type CountKey = keyof Omit<Counts, 'employed'>

interface StatusMeta {
  status: CalendarStatus
  label: string
  /** Short form for pills and circles. */
  code: string
  count: CountKey
  /** Phrase for "25 present", "2 absent". */
  noun: string
}

/** Display order everywhere: what people look for first comes first. */
const STATUSES: StatusMeta[] = [
  { status: 'PRESENT', label: 'Present', code: 'P', count: 'present', noun: 'present' },
  { status: 'ABSENT', label: 'Absent', code: 'A', count: 'absent', noun: 'absent' },
  { status: 'HALF_DAY_LEAVE', label: 'Half day', code: 'HD', count: 'halfDay', noun: 'half day' },
  { status: 'ON_LEAVE', label: 'Leave', code: 'L', count: 'onLeave', noun: 'on leave' },
  { status: 'HOLIDAY', label: 'Holiday', code: 'H', count: 'holiday', noun: 'holiday' },
  { status: 'WEEKLY_OFF', label: 'Weekly off', code: 'WO', count: 'weeklyOff', noun: 'weekly off' },
  { status: 'UNMARKED', label: 'Not marked', code: '–', count: 'unmarked', noun: 'not marked' },
]

const META = new Map(STATUSES.map((entry) => [entry.status, entry]))
const EDITABLE: AttendanceStatus[] = ['PRESENT', 'ABSENT', 'HALF_DAY_LEAVE', 'ON_LEAVE', 'HOLIDAY', 'WEEKLY_OFF']
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// ---------------------------------------------------------------------------
// Dates (ISO strings, UTC arithmetic so time zones never shift a day)
// ---------------------------------------------------------------------------

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`)
}

function addDays(iso: string, days: number): string {
  const date = toUtc(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** 0 for Monday through 6 for Sunday. */
function weekdayIndex(iso: string): number {
  return (toUtc(iso).getUTCDay() + 6) % 7
}

function rangeFor(mode: Mode, anchor: string): { from: string; to: string } {
  if (mode === 'week') {
    const from = addDays(anchor, -weekdayIndex(anchor))
    return { from, to: addDays(from, 6) }
  }
  const year = Number(anchor.slice(0, 4))
  const month = Number(anchor.slice(5, 7))
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from: `${anchor.slice(0, 7)}-01`, to: `${anchor.slice(0, 7)}-${String(last).padStart(2, '0')}` }
}

function shiftAnchor(mode: Mode, anchor: string, direction: 1 | -1): string {
  if (mode === 'week') return addDays(anchor, 7 * direction)
  const date = toUtc(`${anchor.slice(0, 7)}-01`)
  date.setUTCMonth(date.getUTCMonth() + direction)
  return date.toISOString().slice(0, 10)
}

function shortDate(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]?.slice(0, 3) ?? ''}`
}

function longDate(iso: string): string {
  return `${WEEKDAYS[weekdayIndex(iso)]} ${shortDate(iso)} ${iso.slice(0, 4)}`
}

function periodLabel(mode: Mode, from: string, to: string): string {
  if (mode === 'month') return `${MONTH_NAMES[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${shortDate(from)} – ${shortDate(to)} ${to.slice(0, 4)}`
    : `${shortDate(from)} ${from.slice(0, 4)} – ${shortDate(to)} ${to.slice(0, 4)}`
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

const emptyCounts = (): Counts => ({
  present: 0,
  absent: 0,
  onLeave: 0,
  halfDay: 0,
  holiday: 0,
  weeklyOff: 0,
  unmarked: 0,
  employed: 0,
})

/**
 * Attendance rate: days worked (a half day counts half) out of the days people
 * were expected to work. Holidays, weekly offs and unmarked days are left out.
 */
function attendanceRate(counts: Counts): number | null {
  const expected = counts.present + counts.absent + counts.halfDay + counts.onLeave
  if (expected === 0) return null
  return ((counts.present + counts.halfDay * 0.5) / expected) * 100
}

function rateTone(rate: number): 'good' | 'fair' | 'poor' {
  if (rate >= 90) return 'good'
  if (rate >= 75) return 'fair'
  return 'poor'
}

/** A day's counts, dropping "not marked" on days that have not happened yet. */
function countsFor(day: AttendanceCalendarDay, isFuture: boolean): Counts {
  return isFuture ? { ...day.counts, employed: day.counts.employed - day.counts.unmarked, unmarked: 0 } : day.counts
}

function hasMarks(counts: Counts): boolean {
  return STATUSES.some((entry) => entry.status !== 'UNMARKED' && counts[entry.count] > 0)
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function StatusCircle({ status, size = 'md' }: { status: CalendarStatus; size?: 'xs' | 'md' | 'lg' }) {
  const meta = META.get(status)
  return (
    <span className={`att-circle att-circle-${size} att-bg-${status}`} title={meta?.label} aria-label={meta?.label}>
      {size === 'xs' ? null : meta?.code}
    </span>
  )
}

function StatusPill({ status }: { status: CalendarStatus }) {
  const meta = META.get(status)
  return (
    <span className={`att-pill att-soft-${status}`} title={meta?.label}>
      {meta?.code}
    </span>
  )
}

/** The day's split, as one bar whose segments grow with each count. */
function StackedBar({ counts }: { counts: Counts }) {
  const segments = STATUSES.filter((entry) => counts[entry.count] > 0)
  if (segments.length === 0) return <span className="att-bar att-bar-empty" aria-hidden />
  return (
    <span className="att-bar" aria-hidden>
      {segments.map((entry) => (
        <span key={entry.status} className={`att-bar-seg att-bg-${entry.status}`} style={{ flexGrow: counts[entry.count] }} />
      ))}
    </span>
  )
}

function RateBadge({ counts }: { counts: Counts }) {
  const rate = attendanceRate(counts)
  if (rate === null) return null
  return (
    <span className={`att-rate att-rate-${rateTone(rate)}`} title="Attendance rate for the day">
      {Math.round(rate)}%
    </span>
  )
}

function dayAriaLabel(day: AttendanceCalendarDay, counts: Counts): string {
  const parts = STATUSES.filter((entry) => counts[entry.count] > 0).map((entry) => `${counts[entry.count]} ${entry.noun}`)
  return `${longDate(day.date)}${day.holidayName ? `, ${day.holidayName}` : ''}: ${parts.join(', ') || 'nothing recorded'}`
}

function Legend() {
  return (
    <div className="att-legend" aria-label="Legend">
      {STATUSES.map((entry) => (
        <span key={entry.status} className="att-legend-item">
          <StatusCircle status={entry.status} size="xs" />
          {entry.label}
        </span>
      ))}
    </div>
  )
}

function Kpi({ status, value, label }: { status: CalendarStatus; value: number; label: string }) {
  return (
    <div className="att-kpi">
      <span className="att-kpi-label">
        <StatusCircle status={status} size="xs" /> {label}
      </span>
      <span className="att-kpi-value">{Number.isInteger(value) ? value : value.toFixed(1)}</span>
    </div>
  )
}

/** The period in numbers: attendance rate first, then each status. */
function SummaryStrip({ totals, unit }: { totals: Counts; unit: string }) {
  const rate = attendanceRate(totals)
  return (
    <div className="att-kpis">
      <div className="att-kpi att-kpi-rate">
        <span className="att-kpi-label">Attendance rate</span>
        <span className={`att-kpi-value${rate === null ? '' : ` att-rate-text-${rateTone(rate)}`}`}>
          {rate === null ? '—' : `${rate.toFixed(1)}%`}
        </span>
        <span className="att-meter" aria-hidden>
          <span
            className={`att-meter-fill${rate === null ? '' : ` att-meter-${rateTone(rate)}`}`}
            style={{ width: `${Math.min(rate ?? 0, 100)}%` }}
          />
        </span>
      </div>
      <Kpi status="PRESENT" value={totals.present} label="Present" />
      <Kpi status="ABSENT" value={totals.absent} label="Absent" />
      <Kpi status="HALF_DAY_LEAVE" value={totals.halfDay} label="Half day" />
      <Kpi status="ON_LEAVE" value={totals.onLeave} label="Leave" />
      <Kpi status="HOLIDAY" value={totals.holiday + totals.weeklyOff} label="Holiday / off" />
      {totals.unmarked > 0 ? <Kpi status="UNMARKED" value={totals.unmarked} label="Not marked" /> : null}
      <p className="att-kpi-unit">{unit}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Team views
// ---------------------------------------------------------------------------

/** Every non-zero status of the day, one per line, in the usual order. */
function TeamDayStats({ counts }: { counts: Counts }) {
  return (
    <span className="att-day-stats">
      {STATUSES.filter((entry) => counts[entry.count] > 0).map((entry) => (
        <span key={entry.status} className={`att-day-stat att-text-${entry.status}`}>
          <strong>{counts[entry.count]}</strong> {entry.noun}
        </span>
      ))}
    </span>
  )
}

function TeamMonthGrid({
  days,
  today,
  onOpenDay,
}: {
  days: AttendanceCalendarDay[]
  today: string
  onOpenDay: (date: string) => void
}) {
  const leading = days[0] ? weekdayIndex(days[0].date) : 0
  return (
    <div className="att-month" role="grid">
      {WEEKDAYS.map((label) => (
        <div key={label} className="att-weekday" role="columnheader">
          {label}
        </div>
      ))}
      {Array.from({ length: leading }, (_, index) => (
        <div key={`blank-${index}`} className="att-day att-day-blank" aria-hidden />
      ))}
      {days.map((day) => {
        const isFuture = day.date > today
        const counts = countsFor(day, isFuture)
        const marked = hasMarks(counts)
        return (
          <button
            key={day.date}
            type="button"
            role="gridcell"
            className={[
              'att-day att-day-team',
              day.date === today ? 'is-today' : '',
              isFuture ? 'is-future' : '',
              day.holidayName ? 'is-holiday' : '',
            ].join(' ')}
            onClick={() => onOpenDay(day.date)}
            aria-label={dayAriaLabel(day, counts)}
          >
            <span className="att-day-top">
              <span className="att-daynum">{Number(day.date.slice(8, 10))}</span>
              {day.date === today ? <span className="att-today-tag">Today</span> : null}
              <RateBadge counts={counts} />
            </span>
            {day.holidayName ? <span className="att-holiday-tag">{day.holidayName}</span> : null}
            {marked || counts.unmarked > 0 ? (
              <>
                <StackedBar counts={counts} />
                <TeamDayStats counts={counts} />
              </>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

function TeamWeekTable({
  calendar,
  today,
  onOpenDay,
  onPickEmployee,
}: {
  calendar: AttendanceCalendar
  today: string
  onOpenDay: (date: string) => void
  onPickEmployee: (id: string) => void
}) {
  return (
    <div className="att-week-scroll">
      <table className="att-week">
        <caption className="sr-only">Attendance for the week of {longDate(calendar.from)}</caption>
        <thead>
          <tr>
            <th scope="col" className="att-week-emp">
              Employee
            </th>
            {calendar.days.map((day) => {
              const counts = countsFor(day, day.date > today)
              return (
                <th key={day.date} scope="col" className={day.date === today ? 'is-today' : undefined}>
                  <button type="button" className="att-week-head" onClick={() => onOpenDay(day.date)} title={dayAriaLabel(day, counts)}>
                    <span className="att-weekday-name">{WEEKDAYS[weekdayIndex(day.date)]}</span>
                    <span className="att-week-head-row">
                      <span className="att-week-date">{shortDate(day.date)}</span>
                      <RateBadge counts={counts} />
                    </span>
                    {day.holidayName ? <span className="att-holiday-tag">{day.holidayName}</span> : null}
                    <StackedBar counts={counts} />
                    <span className="att-week-head-stats">
                      <span className="att-text-PRESENT">{counts.present} P</span>
                      <span className="att-text-ABSENT">{counts.absent} A</span>
                    </span>
                  </button>
                </th>
              )
            })}
            <th scope="col" className="att-week-total">
              Week
            </th>
          </tr>
        </thead>
        <tbody>
          {calendar.employees.map((employee, index) => {
            const week = emptyCounts()
            for (const day of calendar.days) {
              const status = day.statuses[index]
              if (!status || (status === 'UNMARKED' && day.date > today)) continue
              const key = META.get(status)?.count
              if (key) week[key] += 1
            }
            return (
              <tr key={employee.id}>
                <th scope="row" className="att-week-emp">
                  <span className="att-emp">
                    <Avatar name={employee.name} size={28} />
                    <span className="att-emp-text">
                      <button type="button" className="att-emp-name" onClick={() => onPickEmployee(employee.id)}>
                        {employee.name}
                      </button>
                      <span className="att-emp-meta">
                        {[employee.employeeCode, employee.departmentName].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </span>
                </th>
                {calendar.days.map((day) => {
                  const status = day.statuses[index] ?? null
                  const hidden = status === null || (status === 'UNMARKED' && day.date > today)
                  return (
                    <td key={day.date} className={day.date === today ? 'is-today' : undefined}>
                      {hidden ? null : <StatusPill status={status} />}
                    </td>
                  )
                })}
                <td className="att-week-total">
                  <span className="att-text-PRESENT">{week.present + week.halfDay * 0.5}</span>
                  <span className="subtle"> / {week.present + week.absent + week.halfDay + week.onLeave}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One employee
// ---------------------------------------------------------------------------

function PersonDay({
  day,
  today,
  canEdit,
  variant,
  leaveTypeName,
  onEdit,
}: {
  day: AttendanceCalendarDay
  today: string
  canEdit: boolean
  variant: 'month' | 'week'
  leaveTypeName: string | null
  onEdit: (date: string) => void
}) {
  const status = day.statuses[0] ?? null
  const isFuture = day.date > today
  const employed = status !== null
  const shown = employed && !(status === 'UNMARKED' && isFuture)
  const record = day.record ?? null
  const editable = canEdit && employed && !record?.isLocked
  const label = status === null ? 'Not employed' : (META.get(status)?.label ?? status)
  const aria = `${longDate(day.date)}: ${label}${day.holidayName ? ` (${day.holidayName})` : ''}${record?.isLocked ? ', locked by payroll' : ''}${editable ? '. Click to change.' : ''}`

  const className = [
    'att-day att-day-person',
    `att-day-${variant}`,
    shown && status ? `att-tint-${status}` : '',
    !employed ? 'att-day-blank' : '',
    day.date === today ? 'is-today' : '',
    isFuture ? 'is-future' : '',
    editable ? 'is-editable' : '',
  ].join(' ')

  const content: ReactNode = (
    <>
      <span className="att-day-top">
        {variant === 'week' ? (
          <span className="att-week-dayhead">
            <span className="att-weekday-name">{WEEKDAYS[weekdayIndex(day.date)]}</span>
            <span className="att-week-date">{shortDate(day.date)}</span>
          </span>
        ) : (
          <span className="att-daynum">{Number(day.date.slice(8, 10))}</span>
        )}
        <span className="att-day-icons">
          {record?.isLocked ? <Lock size={12} aria-label="Locked by payroll" /> : null}
          {record?.fromLeaveRequest ? <Palmtree size={12} aria-label="From an approved leave request" /> : null}
          {editable ? <Pencil size={12} className="att-edit-icon" aria-hidden /> : null}
        </span>
      </span>
      {employed ? (
        <span className="att-person-status">
          {shown && status ? <StatusCircle status={status} size="lg" /> : <span className="att-circle att-circle-lg att-circle-empty" />}
          <span className="att-person-label">{shown ? label : ''}</span>
          {variant === 'week' && leaveTypeName ? <span className="att-person-note">{leaveTypeName}</span> : null}
          {variant === 'week' && record?.remarks ? <span className="att-person-note">“{record.remarks}”</span> : null}
        </span>
      ) : null}
      {day.holidayName ? <span className="att-holiday-tag">{day.holidayName}</span> : null}
    </>
  )

  return editable ? (
    <button type="button" role="gridcell" className={className} onClick={() => onEdit(day.date)} aria-label={aria} title={aria}>
      {content}
    </button>
  ) : (
    <div role="gridcell" className={className} aria-label={aria} title={aria}>
      {content}
    </div>
  )
}

function PersonMonth({
  days,
  today,
  canEdit,
  leaveTypeNames,
  onEdit,
}: {
  days: AttendanceCalendarDay[]
  today: string
  canEdit: boolean
  leaveTypeNames: Map<string, string>
  onEdit: (date: string) => void
}) {
  const leading = days[0] ? weekdayIndex(days[0].date) : 0
  return (
    <div className="att-month" role="grid">
      {WEEKDAYS.map((label) => (
        <div key={label} className="att-weekday" role="columnheader">
          {label}
        </div>
      ))}
      {Array.from({ length: leading }, (_, index) => (
        <div key={`blank-${index}`} className="att-day att-day-blank" aria-hidden />
      ))}
      {days.map((day) => (
        <PersonDay
          key={day.date}
          day={day}
          today={today}
          canEdit={canEdit}
          variant="month"
          leaveTypeName={day.record?.leaveTypeId ? (leaveTypeNames.get(day.record.leaveTypeId) ?? null) : null}
          onEdit={onEdit}
        />
      ))}
    </div>
  )
}

function PersonWeek({
  days,
  today,
  canEdit,
  leaveTypeNames,
  onEdit,
}: {
  days: AttendanceCalendarDay[]
  today: string
  canEdit: boolean
  leaveTypeNames: Map<string, string>
  onEdit: (date: string) => void
}) {
  return (
    <div className="att-person-week" role="grid">
      {days.map((day) => (
        <PersonDay
          key={day.date}
          day={day}
          today={today}
          canEdit={canEdit}
          variant="week"
          leaveTypeName={day.record?.leaveTypeId ? (leaveTypeNames.get(day.record.leaveTypeId) ?? null) : null}
          onEdit={onEdit}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Changing one day
// ---------------------------------------------------------------------------

function EditDayModal({
  employee,
  day,
  onClose,
}: {
  employee: CalendarEmployee
  day: AttendanceCalendarDay
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data: leaveTypes } = useLeaveTypes()

  const record = day.record ?? null
  const shown = day.statuses[0] ?? null
  const [status, setStatus] = useState<AttendanceStatus>(
    record?.status ?? (shown && shown !== 'UNMARKED' ? shown : 'PRESENT'),
  )
  const [leaveTypeId, setLeaveTypeId] = useState(record?.leaveTypeId ?? '')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const needsLeaveType = status === 'ON_LEAVE' || status === 'HALF_DAY_LEAVE'
  const leaveOptions = (leaveTypes ?? []).filter((type) => status !== 'HALF_DAY_LEAVE' || type.allowHalfDay)
  const unchanged =
    record !== null &&
    record.status === status &&
    (needsLeaveType ? leaveTypeId : '') === (record.leaveTypeId ?? '') &&
    note.trim() === ''

  const save = useMutation({
    mutationFn: () => {
      const leave = needsLeaveType ? leaveTypeId : null
      const text = note.trim()
      // An existing day is updated in place, which keeps its shift and any
      // link to the leave request that created it; a new day is marked.
      return record
        ? patch(`/attendance/${record.id}`, {
            status,
            leaveTypeId: leave,
            ...(text ? { remarks: text, reason: text } : {}),
          })
        : post('/attendance', {
            employeeId: employee.id,
            attendanceDate: day.date,
            status,
            leaveTypeId: leave,
            remarks: text || null,
          })
    },
    onSuccess: async () => {
      toast.success('Attendance updated', `${employee.name} · ${longDate(day.date)}: ${META.get(status)?.label ?? status}`)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['attendance'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      onClose()
    },
    onError: (saveError: Error) => setError(saveError.message),
  })

  const currentLabel = shown === null ? 'Not employed' : (META.get(shown)?.label ?? shown)
  const source = !record
    ? shown === 'UNMARKED'
      ? 'Nothing marked yet.'
      : `Nothing marked; the company calendar makes it a ${currentLabel.toLowerCase()}.`
    : record.fromLeaveRequest
      ? 'Set by an approved leave request.'
      : record.source === 'IMPORT'
        ? 'Imported from the Face ID sheet.'
        : 'Marked by hand.'

  return (
    <Modal
      open
      title={`${longDate(day.date)}`}
      description={`${employee.name} · ${employee.employeeCode}`}
      onClose={onClose}
      footer={
        record?.isLocked ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setError(null)
                if (needsLeaveType && !leaveTypeId) {
                  setError('Choose the leave type.')
                  return
                }
                save.mutate()
              }}
              loading={save.isPending}
              disabled={unchanged}
            >
              Save
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <div className="att-edit-current">
          {shown ? <StatusCircle status={shown} /> : null}
          <div>
            <p className="att-edit-current-label">Currently {currentLabel.toLowerCase()}</p>
            <p className="subtle">
              {source}
              {day.holidayName ? ` ${day.holidayName}.` : ''}
            </p>
          </div>
        </div>

        {record?.isLocked ? (
          <div className="alert alert-warning">
            <Lock size={14} aria-hidden /> This day is part of a locked payroll run and can no longer be changed. Raise a
            payroll adjustment instead.
          </div>
        ) : (
          <>
            {record?.fromLeaveRequest ? (
              <div className="alert alert-info">
                Changing this day does not cancel or change the leave request itself.
              </div>
            ) : null}
            {error ? (
              <div className="alert alert-error" role="alert">
                {error}
              </div>
            ) : null}

            <fieldset className="att-choices">
              <legend className="sr-only">Status</legend>
              {EDITABLE.map((value) => {
                const meta = META.get(value)
                return (
                  <label key={value} className={`att-choice${status === value ? ' is-selected' : ''}`}>
                    <input
                      type="radio"
                      name="attendance-status"
                      value={value}
                      checked={status === value}
                      onChange={() => setStatus(value)}
                      className="sr-only"
                    />
                    <StatusCircle status={value} />
                    <span>{meta?.label}</span>
                  </label>
                )
              })}
            </fieldset>

            {needsLeaveType ? (
              <Field label="Leave type" htmlFor="edit-leave-type" required>
                <Select id="edit-leave-type" value={leaveTypeId} onChange={(event) => setLeaveTypeId(event.target.value)}>
                  <option value="">Select a leave type</option>
                  {leaveOptions.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                      {type.isPaid ? '' : ' (unpaid)'}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            <Field
              label="Note"
              htmlFor="edit-note"
              hint={record ? 'Optional. Kept with the day and in its change history.' : 'Optional.'}
            >
              <Textarea id="edit-note" rows={2} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
            {record?.remarks ? <p className="subtle">Current note: “{record.remarks}”</p> : null}
          </>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Who, on a given day
// ---------------------------------------------------------------------------

function DayDetailModal({
  day,
  employees,
  isFuture,
  onClose,
  onPickEmployee,
  onOpenSheet,
}: {
  day: AttendanceCalendarDay
  employees: CalendarEmployee[]
  isFuture: boolean
  onClose: () => void
  onPickEmployee: (id: string) => void
  onOpenSheet?: (date: string) => void
}) {
  const groups = useMemo(() => {
    const map = new Map<CalendarStatus, CalendarEmployee[]>()
    day.statuses.forEach((status, index) => {
      const employee = employees[index]
      if (!status || !employee) return
      map.set(status, [...(map.get(status) ?? []), employee])
    })
    return map
  }, [day, employees])

  const counts = countsFor(day, isFuture)
  const available = STATUSES.filter((entry) => counts[entry.count] > 0)
  // Open on the list people usually want: who was missing.
  const preferred = ['ABSENT', 'HALF_DAY_LEAVE', 'ON_LEAVE', 'UNMARKED', 'PRESENT', 'HOLIDAY', 'WEEKLY_OFF'] as const
  const [active, setActive] = useState<CalendarStatus>(
    preferred.find((status) => available.some((entry) => entry.status === status)) ?? 'PRESENT',
  )
  const [search, setSearch] = useState('')

  const term = search.trim().toLowerCase()
  const list = (groups.get(active) ?? []).filter(
    (employee) =>
      !term ||
      employee.name.toLowerCase().includes(term) ||
      employee.employeeCode.toLowerCase().includes(term) ||
      (employee.departmentName ?? '').toLowerCase().includes(term),
  )
  const rate = attendanceRate(counts)

  return (
    <Modal
      open
      size="lg"
      title={longDate(day.date)}
      description={`${day.holidayName ? `${day.holidayName} · ` : ''}${counts.employed} employee(s)${rate === null ? '' : ` · ${Math.round(rate)}% attendance`}`}
      onClose={onClose}
      footer={
        onOpenSheet ? (
          <Button variant="secondary" onClick={() => onOpenSheet(day.date)}>
            Open the daily sheet for this day
          </Button>
        ) : undefined
      }
    >
      {available.length === 0 ? (
        <p className="muted">Nothing recorded for this day yet.</p>
      ) : (
        <div className="stack">
          <StackedBar counts={counts} />
          <Tabs
            tabs={available.map((entry) => ({ key: entry.status, label: entry.label, count: counts[entry.count] }))}
            active={active}
            onChange={(key) => setActive(key as CalendarStatus)}
          />
          {/* Wrapped: the search box is built for a horizontal filter bar and would grow tall in a column. */}
          <div className="row">
            <SearchInput value={search} onChange={setSearch} placeholder="Name, employee ID or department" />
          </div>
          <ul className="att-people" aria-label={`${META.get(active)?.label ?? ''} on ${longDate(day.date)}`}>
            {list.map((employee) => (
              <li key={employee.id}>
                <button
                  type="button"
                  className="att-people-row"
                  onClick={() => onPickEmployee(employee.id)}
                  title="Show this employee's calendar"
                >
                  <Avatar name={employee.name} size={30} />
                  <span className="att-people-main">
                    <span className="att-people-name">{employee.name}</span>
                    <span className="att-people-meta">
                      {[employee.employeeCode, employee.departmentName, employee.designationName].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <StatusPill status={active} />
                </button>
              </li>
            ))}
            {list.length === 0 ? <li className="muted att-people-empty">No one matches that search.</li> : null}
          </ul>
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function AttendanceCalendarView({
  initialEmployeeId,
  onOpenSheet,
}: {
  initialEmployeeId?: string
  /** Offered from a day's list when the viewer can mark attendance. */
  onOpenSheet?: (date: string) => void
}) {
  const today = todayIso()
  const [mode, setMode] = useState<Mode>('month')
  const [anchor, setAnchor] = useState(today)
  const [departmentId, setDepartmentId] = useState('')
  const [supervisorId, setSupervisorId] = useState('')
  const [employeeId, setEmployeeId] = useState(initialEmployeeId ?? '')
  const [openDate, setOpenDate] = useState<string | null>(null)
  const [editDate, setEditDate] = useState<string | null>(null)
  const { data: leaveTypes } = useLeaveTypes()

  const { from, to } = rangeFor(mode, anchor)
  const params = {
    from,
    to,
    departmentId: departmentId || undefined,
    supervisorId: supervisorId || undefined,
    employeeId: employeeId || undefined,
  }

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['attendance', 'calendar', params],
    queryFn: () => get<AttendanceCalendar>('/attendance/calendar', params),
    placeholderData: keepPreviousData,
  })

  const single = data?.employees.length === 1 ? data.employees[0] : null
  const openDay = openDate ? data?.days.find((day) => day.date === openDate) : undefined
  const editDay = editDate && single ? data?.days.find((day) => day.date === editDate) : undefined
  const leaveTypeNames = useMemo(() => new Map((leaveTypes ?? []).map((type) => [type.id, type.name])), [leaveTypes])

  /** The period's totals: person-days for a team, days for one employee. */
  const totals = useMemo(() => {
    const sum = emptyCounts()
    for (const day of data?.days ?? []) {
      const counts = countsFor(day, day.date > today)
      for (const entry of STATUSES) sum[entry.count] += counts[entry.count]
      sum.employed += counts.employed
    }
    return sum
  }, [data, today])

  const pickEmployee = (id: string): void => {
    setOpenDate(null)
    setEmployeeId(id)
  }

  const isCurrentPeriod = today >= from && today <= to

  return (
    <div className="att-calendar">
      <div className="att-header">
        <div className="att-title">
          <h2 className="att-period" aria-live="polite">
            {periodLabel(mode, from, to)}
          </h2>
          <p className="subtle">
            {data
              ? single
                ? 'One employee'
                : `${data.employees.length} employees`
              : 'Loading'}
            {' · '}
            {mode === 'month' ? 'Month view' : 'Week view'}
          </p>
        </div>

        <div className="att-controls">
          <div className="att-nav" role="group" aria-label="Change period">
            <button
              type="button"
              className="att-nav-button"
              aria-label={mode === 'month' ? 'Previous month' : 'Previous week'}
              onClick={() => setAnchor(shiftAnchor(mode, anchor, -1))}
            >
              <ChevronLeft size={16} />
            </button>
            <button type="button" className="att-nav-button att-nav-today" onClick={() => setAnchor(today)} disabled={isCurrentPeriod}>
              Today
            </button>
            <button
              type="button"
              className="att-nav-button"
              aria-label={mode === 'month' ? 'Next month' : 'Next week'}
              onClick={() => setAnchor(shiftAnchor(mode, anchor, 1))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="att-segmented" role="radiogroup" aria-label="Calendar view">
            {(['month', 'week'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                className={`att-segment${mode === value ? ' is-active' : ''}`}
                onClick={() => setMode(value)}
              >
                {value === 'month' ? 'Month' : 'Week'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="filter-bar att-filters">
        <Field label="Department" htmlFor="calendar-department">
          <DepartmentSelector id="calendar-department" value={departmentId} onChange={setDepartmentId} />
        </Field>
        <Field label="Supervisor" htmlFor="calendar-supervisor">
          <SupervisorSelector id="calendar-supervisor" value={supervisorId} onChange={setSupervisorId} />
        </Field>
        <Field label="Employee" htmlFor="calendar-employee">
          <div className="att-employee-field">
            <EmployeeSelector id="calendar-employee" value={employeeId} onChange={(id) => setEmployeeId(id)} />
            {employeeId ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<X size={14} />}
                aria-label="Show everyone"
                title="Show everyone"
                onClick={() => setEmployeeId('')}
              />
            ) : null}
          </div>
        </Field>
      </div>

      <div className="att-body">
        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isLoading || !data ? (
          <Spinner label="Loading the calendar" />
        ) : data.employees.length === 0 ? (
          <p className="muted att-empty">No employees match these filters for {periodLabel(mode, from, to)}.</p>
        ) : (
          <div className={`stack${isFetching ? ' att-refreshing' : ''}`}>
            {single ? (
              <div className="att-person-head">
                <Avatar name={single.name} size={44} />
                <div className="att-person-head-text">
                  <p className="att-person-name">{single.name}</p>
                  <p className="subtle">
                    {[single.employeeCode, single.departmentName, single.designationName, single.supervisorName ? `Reports to ${single.supervisorName}` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                {employeeId ? (
                  <Button size="sm" variant="secondary" onClick={() => setEmployeeId('')}>
                    Show everyone
                  </Button>
                ) : null}
              </div>
            ) : null}

            <SummaryStrip totals={totals} unit={single ? 'Days in this period' : 'Person-days in this period'} />

            {single ? (
              <>
                {data.canEdit ? <p className="subtle att-hint">Click a day to change its status.</p> : null}
                {mode === 'month' ? (
                  <PersonMonth days={data.days} today={today} canEdit={data.canEdit} leaveTypeNames={leaveTypeNames} onEdit={setEditDate} />
                ) : (
                  <PersonWeek days={data.days} today={today} canEdit={data.canEdit} leaveTypeNames={leaveTypeNames} onEdit={setEditDate} />
                )}
              </>
            ) : (
              <>
                <p className="subtle att-hint">
                  Click a day to see who was present, absent or on leave
                  {mode === 'week' ? ', or a name to open that person’s calendar' : ''}.
                </p>
                {mode === 'month' ? (
                  <TeamMonthGrid days={data.days} today={today} onOpenDay={setOpenDate} />
                ) : (
                  <TeamWeekTable calendar={data} today={today} onOpenDay={setOpenDate} onPickEmployee={pickEmployee} />
                )}
              </>
            )}
            <Legend />
          </div>
        )}
      </div>

      {openDay && data ? (
        <DayDetailModal
          key={openDay.date}
          day={openDay}
          employees={data.employees}
          isFuture={openDay.date > today}
          onClose={() => setOpenDate(null)}
          onPickEmployee={pickEmployee}
          onOpenSheet={
            onOpenSheet
              ? (date) => {
                  setOpenDate(null)
                  onOpenSheet(date)
                }
              : undefined
          }
        />
      ) : null}

      {editDay && single ? (
        <EditDayModal key={editDay.date} employee={single} day={editDay} onClose={() => setEditDate(null)} />
      ) : null}
    </div>
  )
}
