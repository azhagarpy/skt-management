import { MONTH_NAMES } from '../../lib/format'
import { Field, Select } from '../ui'

/** From / to month and year pickers, shared by the bonus statement and the tax report. */

export interface MonthRange {
  fromYear: number
  fromMonth: number
  toYear: number
  toMonth: number
}

export function MonthRangeFields({
  idPrefix,
  years,
  value,
  onChange,
  hint,
}: {
  idPrefix: string
  years: number[]
  value: MonthRange
  onChange: (next: Partial<MonthRange>) => void
  hint?: string
}) {
  // A range can start earlier than the year list shown elsewhere.
  const options = Array.from(new Set([...years, value.fromYear, value.toYear])).sort((a, b) => b - a)
  const monthSelect = (id: string, current: number, key: 'fromMonth' | 'toMonth') => (
    <Select id={id} value={current} onChange={(event) => onChange({ [key]: Number(event.target.value) })}>
      {MONTH_NAMES.map((name, index) => (
        <option key={name} value={index + 1}>
          {name}
        </option>
      ))}
    </Select>
  )
  const yearSelect = (id: string, current: number, key: 'fromYear' | 'toYear') => (
    <Select id={id} value={current} onChange={(event) => onChange({ [key]: Number(event.target.value) })}>
      {options.map((year) => (
        <option key={year} value={year}>
          {year}
        </option>
      ))}
    </Select>
  )

  return (
    <div className="stack" style={{ gap: '0.4rem' }}>
      <div className="grid grid-4">
        <Field label="From month" htmlFor={`${idPrefix}-from-month`} required>
          {monthSelect(`${idPrefix}-from-month`, value.fromMonth, 'fromMonth')}
        </Field>
        <Field label="From year" htmlFor={`${idPrefix}-from-year`} required>
          {yearSelect(`${idPrefix}-from-year`, value.fromYear, 'fromYear')}
        </Field>
        <Field label="To month" htmlFor={`${idPrefix}-to-month`} required>
          {monthSelect(`${idPrefix}-to-month`, value.toMonth, 'toMonth')}
        </Field>
        <Field label="To year" htmlFor={`${idPrefix}-to-year`} required>
          {yearSelect(`${idPrefix}-to-year`, value.toYear, 'toYear')}
        </Field>
      </div>
      {hint ? <p className="field-message">{hint}</p> : null}
    </div>
  )
}
