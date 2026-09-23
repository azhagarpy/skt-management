import { useEffect, useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, Upload } from 'lucide-react'
import { upload } from '../../lib/api'
import { formatDate, humanise } from '../../lib/format'
import { useToast } from '../../app/providers/ToastProvider'
import { Badge, Button, ErrorState, Field, Input, Modal, Spinner, StatTile } from '../../components/ui'
import type {
  AttendanceImportConflictMode,
  AttendanceImportPreview,
  AttendanceImportResult,
} from '../../types/api'

/**
 * Import attendance from a Face ID .xlsx export (Muster or Daily Present report).
 *
 * The file is sent to the server for a dry run first, so the admin sees exactly
 * what would change before anything is written. If it would change days that
 * already carry attendance, they must choose between overriding those days and
 * keeping what is there - nothing is pre-selected, and the server refuses to
 * write without the answer.
 */

type DaySelection = 'ALL' | 'ONE' | 'RANGE'

function buildForm(
  file: File,
  fields: { from?: string; to?: string; year?: string; conflictMode?: AttendanceImportConflictMode },
): FormData {
  const form = new FormData()
  form.append('file', file)
  for (const [key, value] of Object.entries(fields)) {
    if (value) form.append(key, value)
  }
  return form
}

export default function AttendanceImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [selection, setSelection] = useState<DaySelection>('ALL')
  const [day, setDay] = useState('')
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')
  const [year, setYear] = useState('')
  const [conflictMode, setConflictMode] = useState<AttendanceImportConflictMode | ''>('')

  // Which days to send. An incomplete or reversed range sends nothing new, so the
  // server keeps answering for the last valid selection instead of erroring per keystroke.
  const days =
    selection === 'ONE'
      ? { from: day, to: day }
      : selection === 'RANGE' && rangeFrom && rangeTo && rangeFrom <= rangeTo
        ? { from: rangeFrom, to: rangeTo }
        : { from: '', to: '' }

  const fileKey = file ? `${file.name}:${file.size}:${file.lastModified}` : null
  const yearValid = /^\d{4}$/.test(year) ? year : ''

  const preview = useQuery({
    queryKey: ['attendance', 'import-preview', fileKey, days.from, days.to, yearValid],
    queryFn: async () => {
      const response = await upload<AttendanceImportPreview>(
        '/attendance/import/preview',
        buildForm(file as File, { ...days, year: yearValid }),
      )
      return response.data
    },
    enabled: open && file !== null,
    retry: false,
    gcTime: 0,
    placeholderData: keepPreviousData,
  })
  const data = preview.data

  // A new file starts from "everything in the sheet"; the chosen days are then
  // seeded from what the sheet actually contains.
  useEffect(() => {
    setSelection('ALL')
    setDay('')
    setRangeFrom('')
    setRangeTo('')
    setConflictMode('')
  }, [fileKey])

  const sheetFrom = data?.sheetFrom
  const sheetTo = data?.sheetTo
  useEffect(() => {
    if (!sheetFrom || !sheetTo) return
    setDay((current) => current || sheetFrom)
    setRangeFrom((current) => current || sheetFrom)
    setRangeTo((current) => current || sheetTo)
  }, [sheetFrom, sheetTo])

  // The answer belongs to one specific set of conflicts; a different selection
  // may have different ones, so ask again.
  useEffect(() => {
    setConflictMode('')
  }, [days.from, days.to, yearValid])

  const commit = useMutation({
    mutationFn: async () => {
      const response = await upload<AttendanceImportResult>(
        '/attendance/import',
        buildForm(file as File, { ...days, year: yearValid, conflictMode: conflictMode || undefined }),
      )
      return response.data
    },
    onSuccess: async (result) => {
      const skipped = Object.values(result.skipped).reduce((sum, count) => sum + count, 0)
      const overridden = result.overridden > 0 ? `, ${result.overridden} overridden` : ''
      toast.success(
        `Attendance imported: ${result.created} added${overridden}`,
        skipped > 0 ? `${skipped} entries were skipped` : undefined,
      )
      await queryClient.invalidateQueries({ queryKey: ['attendance'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      handleClose()
    },
    onError: (error: Error) => toast.error('Could not import the sheet', error.message),
  })

  function handleClose(): void {
    if (commit.isPending) return
    setFile(null)
    setYear('')
    onClose()
  }

  const summary = data?.summary
  const hasConflicts = (summary?.conflicts ?? 0) > 0
  const willWrite = (summary?.create ?? 0) + (conflictMode === 'OVERRIDE' ? (summary?.conflicts ?? 0) : 0)
  const canImport =
    Boolean(data) && !preview.isFetching && !preview.error && willWrite > 0 && (!hasConflicts || conflictMode !== '')
  const skippedTotal = summary
    ? summary.notEmployed + summary.locked + summary.protectedLeave + summary.unrecognisedCodes
    : 0

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="lg"
      title="Import attendance from Face ID sheet"
      description="Upload the Muster Report or Daily Present Report exported from the entrance Face ID system."
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={commit.isPending}>
            Cancel
          </Button>
          <Button icon={<Upload size={15} />} loading={commit.isPending} disabled={!canImport} onClick={() => commit.mutate()}>
            {willWrite > 0 ? `Import ${willWrite} record${willWrite === 1 ? '' : 's'}` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: '1rem' }}>
        <div className="row" style={{ gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <Button variant="secondary" icon={<FileSpreadsheet size={15} />} onClick={() => fileInput.current?.click()}>
            {file ? 'Choose a different file' : 'Choose .xlsx file'}
          </Button>
          {file ? <span className="subtle">{file.name}</span> : null}
        </div>

        {file && preview.error && !data ? <ErrorState error={preview.error} onRetry={() => void preview.refetch()} /> : null}
        {file && preview.isFetching && !data ? <Spinner label="Reading the sheet" /> : null}

        {data ? (
          <>
            <p className="subtle">
              <Badge tone="info">{data.format === 'MUSTER' ? 'Muster report' : 'Daily present report'}</Badge>{' '}
              {data.peopleInSheet} people · {formatDate(data.sheetFrom)}
              {data.sheetFrom === data.sheetTo ? '' : ` – ${formatDate(data.sheetTo)}`} ({data.sheetDates}{' '}
              {data.sheetDates === 1 ? 'day' : 'days'})
              {data.scope === 'TEAM' ? ' · only your team will be updated' : ''}
            </p>

            {data.format === 'MUSTER' ? (
              <Field
                label="Year"
                htmlFor="import-year"
                hint="Muster headers have no year. Dates were read from the file name; enter the year of the last date if they look wrong."
              >
                <Input
                  id="import-year"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder={data.sheetTo.slice(0, 4)}
                  value={year}
                  onChange={(event) => setYear(event.target.value.replace(/\D/g, ''))}
                  style={{ maxWidth: '8rem' }}
                />
              </Field>
            ) : null}

            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field-label">Days to import</legend>
              <div className="row" style={{ gap: '1.25rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                {(
                  [
                    ['ALL', 'Every day in the sheet'],
                    ['ONE', 'A single day'],
                    ['RANGE', 'A range of days'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
                    <input
                      type="radio"
                      name="import-days"
                      checked={selection === value}
                      onChange={() => setSelection(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {selection === 'ONE' ? (
              <Field label="Day" htmlFor="import-day">
                <Input
                  id="import-day"
                  type="date"
                  min={data.sheetFrom}
                  max={data.sheetTo}
                  value={day}
                  onChange={(event) => setDay(event.target.value)}
                  style={{ maxWidth: '12rem' }}
                />
              </Field>
            ) : null}

            {selection === 'RANGE' ? (
              <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
                <Field label="From" htmlFor="import-from">
                  <Input
                    id="import-from"
                    type="date"
                    min={data.sheetFrom}
                    max={data.sheetTo}
                    value={rangeFrom}
                    onChange={(event) => setRangeFrom(event.target.value)}
                  />
                </Field>
                <Field label="To" htmlFor="import-to">
                  <Input
                    id="import-to"
                    type="date"
                    min={rangeFrom || data.sheetFrom}
                    max={data.sheetTo}
                    value={rangeTo}
                    onChange={(event) => setRangeTo(event.target.value)}
                  />
                </Field>
              </div>
            ) : null}

            {summary ? (
              <div className="grid grid-4" style={{ opacity: preview.isFetching ? 0.6 : 1 }}>
                <StatTile label="New" value={summary.create} sublabel="not marked yet" tone="success" />
                <StatTile
                  label="Already marked"
                  value={summary.conflicts}
                  sublabel="differ from the sheet"
                  tone={summary.conflicts > 0 ? 'warning' : 'neutral'}
                />
                <StatTile label="Up to date" value={summary.unchanged} sublabel="same as the sheet" tone="info" />
                <StatTile
                  label="Skipped"
                  value={skippedTotal + data.unknownEmployees.total + data.outOfScope.total}
                  sublabel="see notes below"
                  tone="neutral"
                />
              </div>
            ) : null}

            {hasConflicts && summary ? (
              <div className="alert alert-warning" role="group" aria-label="Existing attendance">
                <p>
                  <strong>{summary.conflicts}</strong> day(s) already have attendance that differs from this sheet.
                  What should happen to them?
                </p>
                <div className="stack" style={{ gap: '0.4rem', marginTop: '0.5rem' }}>
                  <label className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
                    <input
                      type="radio"
                      name="import-conflict"
                      checked={conflictMode === 'OVERRIDE'}
                      onChange={() => setConflictMode('OVERRIDE')}
                    />
                    <span>Override them with the sheet</span>
                  </label>
                  <label className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
                    <input
                      type="radio"
                      name="import-conflict"
                      checked={conflictMode === 'KEEP'}
                      onChange={() => setConflictMode('KEEP')}
                    />
                    <span>Keep what is already marked and only add the new days</span>
                  </label>
                </div>

                <div className="data-table-wrapper" style={{ maxHeight: '14rem', overflow: 'auto', marginTop: '0.75rem' }}>
                  <table className="data-table">
                    <caption className="sr-only">Days that already have different attendance</caption>
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Date</th>
                        <th>Currently</th>
                        <th>Sheet says</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.conflicts.map((conflict) => (
                        <tr key={`${conflict.employeeCode}-${conflict.date}`}>
                          <td data-label="Employee">
                            <strong>{conflict.employeeName}</strong>
                            <p className="subtle">{conflict.employeeCode}</p>
                          </td>
                          <td data-label="Date">{formatDate(conflict.date)}</td>
                          <td data-label="Currently">{humanise(conflict.currentStatus)}</td>
                          <td data-label="Sheet says">{humanise(conflict.sheetStatus)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {summary.conflicts > data.conflicts.length ? (
                  <p className="subtle" style={{ marginTop: '0.4rem' }}>
                    Showing the first {data.conflicts.length} of {summary.conflicts}.
                  </p>
                ) : null}
              </div>
            ) : null}

            <Notes data={data} />
          </>
        ) : null}
      </div>
    </Modal>
  )
}

/** Everything the import will leave alone, and why - so nothing disappears silently. */
function Notes({ data }: { data: AttendanceImportPreview }) {
  const { summary } = data
  const notes: string[] = []

  if (data.unknownEmployees.total > 0) {
    const sample = data.unknownEmployees.items.slice(0, 5).map((item) => item.personId).join(', ')
    notes.push(
      `${data.unknownEmployees.total} person(s) in the sheet have no matching employee ID and were skipped (${sample}${data.unknownEmployees.total > 5 ? ', …' : ''}).`,
    )
  }
  if (data.outOfScope.total > 0) {
    notes.push(
      data.scope === 'TEAM'
        ? `${data.outOfScope.total} person(s) are not assigned to you and were skipped.`
        : `${data.outOfScope.total} person(s) were skipped.`,
    )
  }
  if (summary.absentAsDayOff > 0) notes.push(`${summary.absentAsDayOff} absent mark(s) fall on a paid holiday or weekly off and will be recorded as that day off, so they stay paid.`)
  if (summary.protectedLeave > 0) notes.push(`${summary.protectedLeave} day(s) are on approved leave and were left as they are.`)
  if (summary.locked > 0) notes.push(`${summary.locked} day(s) belong to a locked payroll run and cannot be changed.`)
  if (summary.notEmployed > 0) notes.push(`${summary.notEmployed} day(s) fall before joining or after the exit date.`)
  if (summary.unrecognisedCodes > 0) notes.push(`${summary.unrecognisedCodes} cell(s) hold a code that is not recognised (P, A, HF, WO, H).`)
  if (data.duplicates > 0) notes.push(`${data.duplicates} repeated row(s) in the sheet were merged.`)

  if (notes.length === 0) return null
  return (
    <div>
      <p className="field-label">Notes</p>
      <ul className="subtle" style={{ margin: '0.25rem 0 0 1.1rem' }}>
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  )
}
