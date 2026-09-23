import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { parseAttendanceSheet } from './attendance-import.parser.js'

async function workbook(rows: (string | number | Date | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('data')
  rows.forEach((row) => sheet.addRow(row))
  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe('parseAttendanceSheet - muster', () => {
  const header = ['s.no', 'Person Id', 'Person Name', 'Total Present Days', 'Work Order', '30-Dec', '31-Dec', '1-Jan', '2-Jan']

  it('maps P/A/HF/WO and reads the year from the file name', async () => {
    const buffer = await workbook([
      header,
      [1, 'sent0007', 'M.BALAKRISHNAN  M', 3, 305, 'P', 'A', 'HF', 'WO'],
    ])
    const parsed = await parseAttendanceSheet(buffer, { fileName: 'Muster Report Jan-2027.xlsx' })

    expect(parsed.format).toBe('MUSTER')
    expect(parsed.people).toBe(1)
    // The Dec columns belong to the year before the last column's year.
    expect(parsed.dates).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
    expect(parsed.entries.map((entry) => [entry.date, entry.status])).toEqual([
      ['2026-12-30', 'PRESENT'],
      ['2026-12-31', 'ABSENT'],
      ['2027-01-01', 'HALF_DAY_LEAVE'],
      ['2027-01-02', 'WEEKLY_OFF'],
    ])
    // Ids are upper-cased so they compare with employee codes; names are tidied.
    expect(parsed.entries[0]).toMatchObject({ personId: 'SENT0007', personName: 'M.BALAKRISHNAN M' })
  })

  it('honours an explicit year over the file name', async () => {
    const buffer = await workbook([header, [1, 'SENT1', 'A', 0, 0, 'P', 'P', 'P', 'P']])
    const parsed = await parseAttendanceSheet(buffer, { fileName: 'Muster Report Jan-2027.xlsx', year: 2030 })
    expect(parsed.dates[0]).toBe('2029-12-30')
    expect(parsed.dates[3]).toBe('2030-01-02')
  })

  it('leaves blank days out and reports unknown codes instead of guessing', async () => {
    const buffer = await workbook([header, [1, 'SENT2', 'B', 0, 0, 'P', null, 'CL', 'P']])
    const parsed = await parseAttendanceSheet(buffer, { year: 2027 })
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.unrecognised).toEqual([{ personId: 'SENT2', date: '2027-01-01', code: 'CL' }])
  })

  it('reads header cells that are real dates', async () => {
    const buffer = await workbook([
      ['Person Id', 'Person Name', new Date(Date.UTC(2026, 6, 21)), new Date(Date.UTC(2026, 6, 22))],
      ['SENT3', 'C', 'P', 'A'],
    ])
    const parsed = await parseAttendanceSheet(buffer)
    expect(parsed.dates).toEqual(['2026-07-21', '2026-07-22'])
  })
})

describe('parseAttendanceSheet - daily present report', () => {
  const header = ['Person Id', 'Person Name', 'Schedule Date', 'In Punch Date', 'Actual In Time', 'Out Punch Date']

  it('marks everyone listed present on their punch-in date', async () => {
    const buffer = await workbook([
      header,
      ['SENT0007', 'A', null, '17/09/2026', '14:00', '17/09/2026'],
      // A night shift punches out the next morning; the day is still the punch-in day.
      ['SENT0112', 'B', '17/09/2026', '17/09/2026', '21:41', '18/09/2026'],
    ])
    const parsed = await parseAttendanceSheet(buffer)
    expect(parsed.format).toBe('DAILY_PRESENT')
    expect(parsed.dates).toEqual(['2026-09-17'])
    expect(parsed.entries.every((entry) => entry.status === 'PRESENT')).toBe(true)
    expect(parsed.entries).toHaveLength(2)
  })

  it('falls back to the schedule date when there is no punch-in date', async () => {
    const buffer = await workbook([header, ['SENT0320', 'C', '17/09/2026', null, null, '17/09/2026']])
    const parsed = await parseAttendanceSheet(buffer)
    expect(parsed.entries[0]?.date).toBe('2026-09-17')
  })

  it('collapses repeated rows for the same person and day', async () => {
    const buffer = await workbook([
      header,
      ['SENT1', 'A', null, '17/09/2026', '06:00', null],
      ['SENT1', 'A', null, '17/09/2026', '14:00', null],
    ])
    const parsed = await parseAttendanceSheet(buffer)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.duplicates).toBe(1)
  })
})

describe('parseAttendanceSheet - rejects bad input', () => {
  it('refuses a file that is not a workbook', async () => {
    await expect(parseAttendanceSheet(Buffer.from('Person Id,Name\nX,Y'))).rejects.toThrow(/not a valid \.xlsx/)
  })

  it('refuses a workbook that is not a Face ID report', async () => {
    const buffer = await workbook([['Name', 'Salary'], ['A', 1]])
    await expect(parseAttendanceSheet(buffer)).rejects.toThrow(/not a recognised Face ID report/)
  })
})
