import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react'
import { get } from '../../lib/api'
import { MONTH_NAMES, todayIso } from '../../lib/format'
import { Button, ErrorState, Spinner } from '../../components/ui'
import type { PaidOffCalendar, PaidOffDay } from '../../types/api'

/**
 * Choosing a paid off's date on the employee's own month.
 *
 * Every day shows what it already is for them - a holiday, a weekly off (their
 * usual one, a one-off, or a paid off already scheduled), leave approved or
 * asked for, attendance already marked, a payroll month already approved - and
 * only the days a paid off can go on are clickable. The server works out which
 * those are with the same check it makes when the paid off is scheduled
 * (GET /overtime/paid-offs/calendar).
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function monthRange(anchor: string): { from: string; to: string } {
  const year = Number(anchor.slice(0, 4))
  const month = Number(anchor.slice(5, 7))
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from: `${anchor.slice(0, 7)}-01`, to: `${anchor.slice(0, 7)}-${String(last).padStart(2, '0')}` }
}

function shiftMonth(anchor: string, direction: 1 | -1): string {
  const date = new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + direction)
  return date.toISOString().slice(0, 10)
}

/** 0 for Monday through 6 for Sunday. */
function weekdayIndex(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7
}

/** "Wednesday, 14 October 2026". */
export function longDate(iso: string): string {
  const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  return `${names[weekdayIndex(iso)]}, ${Number(iso.slice(8, 10))} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`
}

/** How a day looks: its label, a short code for its circle, and the classes that colour it. */
interface Look {
  label: string
  code: string
  tint: string
  circle: string
}

const ATTENDANCE_LOOKS: Record<string, Look> = {
  PRESENT: { label: 'Present', code: 'P', tint: 'att-tint-PRESENT', circle: 'att-bg-PRESENT' },
  ABSENT: { label: 'Absent', code: 'A', tint: 'att-tint-ABSENT', circle: 'att-bg-ABSENT' },
  HALF_DAY_LEAVE: { label: 'Half day', code: 'HD', tint: 'att-tint-HALF_DAY_LEAVE', circle: 'att-bg-HALF_DAY_LEAVE' },
  ON_LEAVE: { label: 'Leave', code: 'L', tint: 'att-tint-ON_LEAVE', circle: 'att-bg-ON_LEAVE' },
  HOLIDAY: { label: 'Holiday', code: 'H', tint: 'att-tint-HOLIDAY', circle: 'att-bg-HOLIDAY' },
  WEEKLY_OFF: { label: 'Weekly off', code: 'WO', tint: 'att-tint-WEEKLY_OFF', circle: 'att-bg-WEEKLY_OFF' },
}

const AVAILABLE: Look = { label: 'Available', code: '✓', tint: 'po-available', circle: 'po-bg-available' }

function lookOf(day: PaidOffDay): Look | null {
  if (!day.employed) return null
  if (day.offSource === 'PAID_OFF') return { label: 'Paid off', code: 'PO', tint: 'po-paid-off', circle: 'po-bg-paid-off' }
  if (day.kind === 'HOLIDAY') return { ...ATTENDANCE_LOOKS.HOLIDAY!, label: day.holidayName ?? 'Holiday' }
  if (day.kind === 'WEEKLY_OFF') {
    const label =
      day.offSource === 'EXTRA' ? 'Extra weekly off' : day.offSource === 'OVERTIME' ? 'Weekly off (overtime)' : 'Weekly off'
    return { ...ATTENDANCE_LOOKS.WEEKLY_OFF!, label }
  }
  if (day.attendance && ATTENDANCE_LOOKS[day.attendance]) {
    const look = ATTENDANCE_LOOKS[day.attendance]!
    return day.attendance === 'ON_LEAVE' && day.leave ? { ...look, label: `Leave · ${day.leave.typeName}` } : look
  }
  if (day.leave) {
    return day.leave.status === 'APPROVED'
      ? { ...ATTENDANCE_LOOKS.ON_LEAVE!, label: `Leave · ${day.leave.typeName}` }
      : { label: `Leave asked · ${day.leave.typeName}`, code: 'L?', tint: 'po-pending', circle: 'po-bg-pending' }
  }
  if (day.selectable) return day.isHalfWeeklyOff ? { ...AVAILABLE, label: 'Available (half day)' } : AVAILABLE
  return { label: 'Not available', code: '–', tint: '', circle: 'att-bg-UNMARKED' }
}

const LEGEND: { label: string; circle: string }[] = [
  { label: 'Available', circle: 'po-bg-available' },
  { label: 'Paid off', circle: 'po-bg-paid-off' },
  { label: 'Weekly off', circle: 'att-bg-WEEKLY_OFF' },
  { label: 'Holiday', circle: 'att-bg-HOLIDAY' },
  { label: 'Leave', circle: 'att-bg-ON_LEAVE' },
  { label: 'Leave asked', circle: 'po-bg-pending' },
  { label: 'Present', circle: 'att-bg-PRESENT' },
  { label: 'Absent', circle: 'att-bg-ABSENT' },
  { label: 'Half day', circle: 'att-bg-HALF_DAY_LEAVE' },
]

export function PaidOffDatePicker({
  employeeId,
  value,
  onChange,
}: {
  employeeId: string
  value: string
  onChange: (date: string) => void
}) {
  const today = todayIso()
  const [anchor, setAnchor] = useState(() => value || today)
  const { from, to } = monthRange(anchor)

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['overtime-paid-off-calendar', employeeId, from],
    queryFn: () => get<PaidOffCalendar>('/overtime/paid-offs/calendar', { employeeId, from, to }),
    placeholderData: keepPreviousData,
  })

  // A month just paged to shows the previous one's days until it arrives; draw
  // only days of the month on screen.
  const days = (data?.days ?? []).filter((day) => day.date >= from && day.date <= to)
  const freeDays = days.filter((day) => day.selectable).length
  const leading = days[0] ? weekdayIndex(days[0].date) : 0
  const monthTitle = `${MONTH_NAMES[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`

  return (
    <div className="po-picker">
      <div className="po-head">
        <Button size="sm" variant="ghost" icon={<ChevronLeft size={15} />} aria-label="Previous month" onClick={() => setAnchor(shiftMonth(anchor, -1))} />
        <div className="po-head-title">
          <strong>{monthTitle}</strong>
          <span className="subtle">
            {isFetching && !data ? 'Loading…' : `${freeDays} day${freeDays === 1 ? '' : 's'} available this month`}
          </span>
        </div>
        <Button size="sm" variant="ghost" icon={<ChevronRight size={15} />} aria-label="Next month" onClick={() => setAnchor(shiftMonth(anchor, 1))} />
        {isFetching && data ? <Spinner /> : null}
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className="att-month po-month" role="grid" aria-label={`Choose a paid off date in ${monthTitle}`}>
          {WEEKDAYS.map((label) => (
            <div key={label} className="att-weekday" role="columnheader">
              {label}
            </div>
          ))}
          {Array.from({ length: leading }, (_, index) => (
            <div key={`blank-${index}`} className="att-day att-day-blank" aria-hidden />
          ))}
          {days.map((day) => {
            const look = lookOf(day)
            const selected = day.date === value
            const why = day.selectable ? 'Click to choose this day' : (day.reason ?? 'Not available')
            const title = `${longDate(day.date)}: ${look?.label ?? 'Not employed'}. ${why}.`
            const className = [
              'att-day po-day',
              look?.tint ?? '',
              day.employed ? '' : 'att-day-blank',
              day.date === today ? 'is-today' : '',
              selected ? 'is-selected' : '',
              day.selectable ? 'is-selectable' : 'is-unavailable',
            ].join(' ')

            const content = (
              <>
                <span className="att-day-top">
                  <span className="att-daynum">{Number(day.date.slice(8, 10))}</span>
                  <span className="att-day-icons">
                    {day.payrollClosed ? <Lock size={12} aria-label="Payroll approved" /> : null}
                  </span>
                </span>
                {look ? (
                  <span className="po-day-body">
                    <span className={`att-circle att-circle-md ${look.circle}`} aria-hidden>
                      {look.code}
                    </span>
                    <span className="po-label">{look.label}</span>
                  </span>
                ) : (
                  <span className="po-label">Not employed</span>
                )}
              </>
            )

            return day.selectable ? (
              <button
                key={day.date}
                type="button"
                role="gridcell"
                aria-selected={selected}
                className={className}
                title={title}
                aria-label={title}
                onClick={() => onChange(day.date)}
              >
                {content}
              </button>
            ) : (
              <div key={day.date} role="gridcell" aria-disabled className={className} title={title} aria-label={title}>
                {content}
              </div>
            )
          })}
        </div>
      )}

      <div className="att-legend po-legend" aria-label="Legend">
        {LEGEND.map((entry) => (
          <span key={entry.label} className="att-legend-item">
            <span className={`att-circle att-circle-xs ${entry.circle}`} aria-hidden />
            {entry.label}
          </span>
        ))}
        <span className="att-legend-item">
          <Lock size={11} aria-hidden /> Payroll approved
        </span>
      </div>

      <p className="po-selected" aria-live="polite">
        {value ? (
          <>
            Paid off on <strong>{longDate(value)}</strong>
          </>
        ) : (
          'Choose one of the green days. Hover over any other day to see why it cannot be used.'
        )}
      </p>
    </div>
  )
}
