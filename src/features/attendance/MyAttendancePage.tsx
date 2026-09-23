import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { get } from '../../lib/api'
import { MONTH_NAMES } from '../../lib/format'
import { Button, Card, ErrorState, Field, PageHeader, Select, Spinner, StatTile } from '../../components/ui'
import { MonthlyCalendarView } from './MonthlyCalendarView'
import type { MonthlyCalendar } from '../../types/api'

/** An employee's own attendance calendar, month by month. */
export default function MyAttendancePage() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['attendance', 'monthly', 'me', year, month],
    queryFn: () => get<MonthlyCalendar>('/attendance/monthly', { year, month, employeeId: 'me' }),
  })

  const step = (delta: number): void => {
    const next = month + delta
    if (next < 1) {
      setMonth(12)
      setYear(year - 1)
    } else if (next > 12) {
      setMonth(1)
      setYear(year + 1)
    } else {
      setMonth(next)
    }
  }

  const years = Array.from({ length: 6 }, (_, index) => now.getFullYear() - index)

  return (
    <div className="page">
      <PageHeader
        title="My attendance"
        description="Your attendance record. Weekly offs and holidays come from the company calendar."
        actions={
          <>
            <Button variant="secondary" icon={<ChevronLeft size={15} />} onClick={() => step(-1)} aria-label="Previous month" />
            <Field label="" htmlFor="month">
              <Select id="month" value={month} onChange={(event) => setMonth(Number(event.target.value))}>
                {MONTH_NAMES.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="" htmlFor="year">
              <Select id="year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
                {years.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Button variant="secondary" onClick={() => step(1)} aria-label="Next month">
              <ChevronRight size={15} />
            </Button>
          </>
        }
      />

      {isLoading ? <Spinner label="Loading your attendance" /> : null}
      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      {data ? (
        <>
          <div className="grid grid-4">
            <StatTile label="Present" value={data.counts.present} tone="success" />
            <StatTile label="Absent" value={data.counts.absent} tone={data.counts.absent > 0 ? 'danger' : 'neutral'} />
            <StatTile
              label="Leave"
              value={data.counts.onLeave + data.counts.halfDayLeave}
              sublabel={`${data.counts.halfDayLeave} half day`}
              tone="warning"
            />
            <StatTile
              label="Working days"
              value={data.workingDays}
              sublabel={`${data.counts.holiday} holidays · ${data.counts.weeklyOff} weekly offs`}
              tone="info"
            />
          </div>

          <Card title={data.monthLabel} description={data.counts.unmarked > 0 ? `${data.counts.unmarked} day(s) not yet marked.` : undefined}>
            <MonthlyCalendarView calendar={data} />
          </Card>
        </>
      ) : null}
    </div>
  )
}
