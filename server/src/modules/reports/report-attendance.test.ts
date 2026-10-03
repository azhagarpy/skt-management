import { describe, expect, it } from 'vitest'
import { attendanceDayStatus, attendanceRowCells, type AttendanceDayStatus } from './report-attendance.js'
import { findReportDefinition } from './report-definitions.js'
import { chooseColumns } from './reports.service.js'

describe('attendanceDayStatus', () => {
  const working = { kind: 'WORKING' as const, isPaidOff: false }

  it('shows what was marked', () => {
    expect(attendanceDayStatus('ABSENT', working)).toBe('ABSENT')
    expect(attendanceDayStatus('PRESENT', { kind: 'HOLIDAY', isPaidOff: false })).toBe('PRESENT')
  })

  it('falls back to what the calendar makes an unmarked day', () => {
    expect(attendanceDayStatus(null, { kind: 'HOLIDAY', isPaidOff: false })).toBe('HOLIDAY')
    expect(attendanceDayStatus(undefined, { kind: 'WEEKLY_OFF', isPaidOff: false })).toBe('WEEKLY_OFF')
    expect(attendanceDayStatus(null, working)).toBe('UNMARKED')
  })

  it('shows a weekly off on a paid off date as the paid off it is', () => {
    expect(attendanceDayStatus(null, { kind: 'WEEKLY_OFF', isPaidOff: true })).toBe('PAID_OFF')
    expect(attendanceDayStatus('WEEKLY_OFF', { kind: 'WEEKLY_OFF', isPaidOff: true })).toBe('PAID_OFF')
  })
})

describe('attendanceRowCells', () => {
  const dates = ['2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24']
  const statuses: Record<string, AttendanceDayStatus> = {
    '2026-08-21': 'PRESENT',
    '2026-08-22': 'HALF_DAY_LEAVE',
    '2026-08-23': 'WEEKLY_OFF',
    '2026-08-24': 'UNMARKED',
  }
  const statusOn = (date: string): AttendanceDayStatus => statuses[date] as AttendanceDayStatus

  it('gives every day a code and counts each status', () => {
    const cells = attendanceRowCells(dates, { joiningDate: '2020-01-01', exitDate: null }, statusOn)
    expect(cells).toMatchObject({
      'day_2026-08-21': 'P',
      'day_2026-08-22': 'HL',
      'day_2026-08-23': 'WO',
      'day_2026-08-24': 'NM',
      present_days: 1,
      half_days: 1,
      weekly_off_days: 1,
      unmarked_days: 1,
      absent_days: 0,
    })
  })

  it('leaves the days outside employment blank and uncounted', () => {
    const cells = attendanceRowCells(dates, { joiningDate: '2026-08-22', exitDate: '2026-08-23' }, statusOn)
    expect(cells['day_2026-08-21']).toBeNull()
    expect(cells['day_2026-08-24']).toBeNull()
    expect(cells.present_days).toBe(0)
    expect(cells.half_days).toBe(1)
    expect(cells.unmarked_days).toBe(0)
  })

  it('has only the totals for the summary', () => {
    const cells = attendanceRowCells(dates, { joiningDate: '2020-01-01', exitDate: null }, statusOn, false)
    expect(Object.keys(cells).some((key) => key.startsWith('day_'))).toBe(false)
    expect(cells.present_days).toBe(1)
  })
})

describe('Monthly Attendance columns', () => {
  const definition = findReportDefinition('monthly-attendance-summary')!

  it('has a column for each day of the period, between the employee and the totals', () => {
    const columns = definition.columnsFor!({ from: '2026-08-21', to: '2026-09-20' })
    const days = columns.filter((column) => column.key.startsWith('day_'))
    expect(days).toHaveLength(31)
    expect(days[0]).toMatchObject({ key: 'day_2026-08-21', label: '21/8' })
    expect(days[30]).toMatchObject({ key: 'day_2026-09-20', label: '20/9' })
    expect(columns[0]?.key).toBe('employee_code')
    expect(columns[columns.length - 1]?.key).toBe('unmarked_days')
  })

  it('refuses a period longer than two months', () => {
    expect(() => definition.columnsFor!({ from: '2026-01-01', to: '2026-06-30' })).toThrow(/up to 62 days/)
  })
})

describe('chooseColumns', () => {
  const definition = findReportDefinition('bank-transfer')!

  it('keeps the columns asked for, in the report order', () => {
    const chosen = chooseColumns(definition, ['net_salary', 'employee_code', 'account_number'])
    expect(chosen.columns.map((column) => column.key)).toEqual(['employee_code', 'account_number', 'net_salary'])
  })

  it('keeps every column when none, or none that exist, are asked for', () => {
    expect(chooseColumns(definition, undefined).columns).toHaveLength(definition.columns.length)
    expect(chooseColumns(definition, ['no_such_column']).columns).toHaveLength(definition.columns.length)
  })
})
