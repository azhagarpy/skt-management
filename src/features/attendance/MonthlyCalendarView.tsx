import { formatDate } from '../../lib/format'
import type { MonthlyCalendar } from '../../types/api'

/**
 * The monthly attendance calendar (plan section 7).
 *
 * Days are laid out on a Monday-first grid with the short status codes from the
 * plan: P, A, L, HL, H and WO.
 */

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const LEGEND: { code: string; label: string; status: string }[] = [
  { code: 'P', label: 'Present', status: 'PRESENT' },
  { code: 'A', label: 'Absent', status: 'ABSENT' },
  { code: 'L', label: 'On leave', status: 'ON_LEAVE' },
  { code: 'HL', label: 'Half day', status: 'HALF_DAY_LEAVE' },
  { code: 'H', label: 'Holiday', status: 'HOLIDAY' },
  { code: 'WO', label: 'Weekly off', status: 'WEEKLY_OFF' },
]

export function MonthlyCalendarView({ calendar }: { calendar: MonthlyCalendar }) {
  // Monday-first offset for the first day of the month.
  const firstDate = calendar.days[0]?.date
  const leadingBlanks = firstDate ? (new Date(`${firstDate}T00:00:00Z`).getUTCDay() + 6) % 7 : 0

  return (
    <div>
      <div className="attendance-calendar" role="grid" aria-label={`Attendance for ${calendar.monthLabel}`}>
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="calendar-weekday" role="columnheader">
            {label}
          </div>
        ))}

        {Array.from({ length: leadingBlanks }, (_, index) => (
          <div key={`blank-${index}`} className="calendar-day calendar-day-empty" aria-hidden />
        ))}

        {calendar.days.map((day) => {
          const dayNumber = Number(day.date.slice(8, 10))
          const statusClass = day.status ? ` status-${day.status}` : ''
          const code = day.statusCode ?? (day.isEmployed ? '·' : '')
          const label = day.holidayName
            ? `${formatDate(day.date)}: ${day.holidayName}`
            : `${formatDate(day.date)}: ${day.status ? day.status.replace(/_/g, ' ').toLowerCase() : 'not marked'}`

          return (
            <div
              key={day.date}
              className={`calendar-day${statusClass}${day.isEmployed ? '' : ' calendar-day-empty'}`}
              role="gridcell"
              title={label}
              aria-label={label}
            >
              <span className="calendar-day-number">{dayNumber}</span>
              {day.isEmployed ? <span className="calendar-day-code">{code}</span> : null}
            </div>
          )
        })}
      </div>

      <div className="calendar-legend">
        {LEGEND.map((entry) => (
          <span key={entry.code} className="calendar-legend-item">
            <span className={`legend-swatch calendar-day status-${entry.status}`} style={{ minHeight: 0 }} aria-hidden />
            <strong>{entry.code}</strong> {entry.label}
          </span>
        ))}
      </div>
    </div>
  )
}
