import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, CheckCheck, FileUp, Lock, Save, Wand2 } from 'lucide-react'
import { get, post } from '../../lib/api'
import { formatDate, todayIso } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  Field,
  Input,
  PageHeader,
  SearchInput,
  Select,
  Spinner,
  StatTile,
} from '../../components/ui'
import { DepartmentSelector, SupervisorSelector, useLeaveTypes, useShifts } from '../../components/forms/selectors'
import type { AttendanceStatus, DailySheet } from '../../types/api'
import AttendanceImportModal from './AttendanceImportModal'

/**
 * The daily attendance sheet (plan section 6).
 *
 * Status-based only: there is no check-in, check-out or working-hours input.
 * Edits are held locally until saved, so marking a whole department is one
 * request rather than one per employee.
 */

const STATUS_OPTIONS: { value: AttendanceStatus; label: string }[] = [
  { value: 'PRESENT', label: 'Present' },
  { value: 'ABSENT', label: 'Absent' },
  { value: 'ON_LEAVE', label: 'On leave' },
  { value: 'HALF_DAY_LEAVE', label: 'Half day leave' },
  { value: 'HOLIDAY', label: 'Holiday' },
  { value: 'WEEKLY_OFF', label: 'Weekly off' },
]

interface PendingEntry {
  status: AttendanceStatus
  leaveTypeId?: string | null
  shiftId?: string | null
}

export default function AttendancePage() {
  const { can } = useAuth()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data: leaveTypes } = useLeaveTypes()
  const { data: shifts } = useShifts()

  const [date, setDate] = useState(todayIso())
  const [departmentId, setDepartmentId] = useState('')
  const [supervisorId, setSupervisorId] = useState('')
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<Record<string, PendingEntry>>({})
  const [confirmCalendar, setConfirmCalendar] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const filters = {
    date,
    departmentId: departmentId || undefined,
    supervisorId: supervisorId || undefined,
    search: search || undefined,
  }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['attendance', 'daily', filters],
    queryFn: () => get<DailySheet>('/attendance/daily', filters),
  })

  // Changing the date or filters discards unsaved edits, which is safer than
  // silently applying them to a different day.
  useEffect(() => {
    setPending({})
  }, [date, departmentId, supervisorId])

  const canManage = can('attendance.manage.all') || can('attendance.manage.team')

  const saveMutation = useMutation({
    mutationFn: (
      entries: { employeeId: string; status: AttendanceStatus; leaveTypeId?: string | null; shiftId?: string | null }[],
    ) =>
      post<{ saved: number; skipped: { employeeId: string; reason: string }[] }>('/attendance/bulk', {
        attendanceDate: date,
        entries,
      }),
    onSuccess: async (response) => {
      const { saved, skipped } = response.data
      if (skipped.length > 0) {
        toast.notify('warning', `Saved ${saved} record(s)`, `${skipped.length} were skipped: ${skipped[0]?.reason ?? ''}`)
      } else {
        toast.success(`Saved attendance for ${saved} employee(s)`)
      }
      setPending({})
      await queryClient.invalidateQueries({ queryKey: ['attendance'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (mutationError: Error) => toast.error('Could not save attendance', mutationError.message),
  })

  const calendarMutation = useMutation({
    mutationFn: () => post<{ created: number; cleared: number }>('/attendance/apply-calendar', { from: date, to: date }),
    onSuccess: async (response) => {
      const { created, cleared } = response.data
      toast.success(
        `Applied calendar defaults to ${created} record(s)`,
        cleared > 0 ? `${cleared} day(s) that are no longer a holiday or weekly off were set back to not marked` : undefined,
      )
      setConfirmCalendar(false)
      await queryClient.invalidateQueries({ queryKey: ['attendance'] })
    },
    onError: (mutationError: Error) => {
      setConfirmCalendar(false)
      toast.error('Could not apply the calendar', mutationError.message)
    },
  })

  const employees = data?.employees ?? []

  /** The status shown for a row: the unsaved edit if there is one, else the saved value. */
  const statusFor = (employeeId: string, saved: AttendanceStatus | null): AttendanceStatus | '' =>
    pending[employeeId]?.status ?? saved ?? ''

  const setStatus = (employeeId: string, status: AttendanceStatus): void => {
    setPending((current) => {
      const entry: PendingEntry = {
        status,
        leaveTypeId: current[employeeId]?.leaveTypeId ?? null,
        shiftId: current[employeeId]?.shiftId,
      }
      // Leave types only apply to leave statuses.
      if (status !== 'ON_LEAVE' && status !== 'HALF_DAY_LEAVE') entry.leaveTypeId = null
      return { ...current, [employeeId]: entry }
    })
  }

  const setLeaveType = (employeeId: string, leaveTypeId: string, saved: AttendanceStatus | null): void => {
    setPending((current) => ({
      ...current,
      [employeeId]: {
        status: current[employeeId]?.status ?? saved ?? 'ON_LEAVE',
        leaveTypeId: leaveTypeId || null,
        shiftId: current[employeeId]?.shiftId,
      },
    }))
  }

  const shiftFor = (employeeId: string, saved: string | null): string =>
    pending[employeeId]?.shiftId !== undefined ? (pending[employeeId]?.shiftId ?? '') : (saved ?? '')

  const setShift = (employeeId: string, shiftId: string, saved: AttendanceStatus | null): void => {
    setPending((current) => ({
      ...current,
      [employeeId]: {
        status: current[employeeId]?.status ?? saved ?? 'PRESENT',
        leaveTypeId: current[employeeId]?.leaveTypeId ?? null,
        shiftId: shiftId || null,
      },
    }))
  }

  const markAllPresent = (): void => {
    const next: Record<string, PendingEntry> = {}
    for (const employee of employees) {
      if (employee.isLocked) continue
      // Respect the configured calendar: a weekly off stays a weekly off. Keep
      // whatever shift was already on the row rather than clearing it.
      next[employee.employeeId] = { status: employee.suggestedStatus, leaveTypeId: null, shiftId: employee.shiftId }
    }
    setPending(next)
  }

  const pendingEntries = useMemo(
    () =>
      Object.entries(pending).map(([employeeId, entry]) => ({
        employeeId,
        status: entry.status,
        leaveTypeId: entry.leaveTypeId ?? null,
        shiftId: entry.shiftId ?? null,
      })),
    [pending],
  )

  // Leave statuses need a leave type before they can be saved.
  const invalidEntries = pendingEntries.filter(
    (entry) => (entry.status === 'ON_LEAVE' || entry.status === 'HALF_DAY_LEAVE') && !entry.leaveTypeId,
  )

  const summary = data?.summary

  return (
    <div className="page">
      <PageHeader
        title="Attendance"
        description="Mark attendance by status. Weekly offs and holidays come from the configured calendar."
        actions={
          canManage ? (
            <>
              <Button variant="secondary" icon={<FileUp size={15} />} onClick={() => setImportOpen(true)}>
                Import sheet
              </Button>
              <Button variant="secondary" icon={<Wand2 size={15} />} onClick={() => setConfirmCalendar(true)}>
                Apply calendar
              </Button>
              <Button variant="secondary" icon={<CheckCheck size={15} />} onClick={markAllPresent}>
                Mark all
              </Button>
              <Button
                icon={<Save size={15} />}
                loading={saveMutation.isPending}
                disabled={pendingEntries.length === 0 || invalidEntries.length > 0}
                onClick={() => saveMutation.mutate(pendingEntries)}
              >
                Save {pendingEntries.length > 0 ? `(${pendingEntries.length})` : ''}
              </Button>
            </>
          ) : null
        }
      />

      {summary ? (
        <div className="grid grid-4">
          <StatTile label="Employees" value={summary.total} sublabel={`${summary.unmarked} not marked`} tone="info" icon={<CalendarCheck size={18} />} />
          <StatTile label="Present" value={summary.present} tone="success" />
          <StatTile label="Absent" value={summary.absent} tone={summary.absent > 0 ? 'danger' : 'neutral'} />
          <StatTile label="Leave" value={summary.onLeave + summary.halfDay} sublabel={`${summary.halfDay} half day`} tone="warning" />
        </div>
      ) : null}

      {invalidEntries.length > 0 ? (
        <div className="alert alert-warning">
          {invalidEntries.length} row(s) are set to leave but have no leave type selected. Pick a leave type before saving.
        </div>
      ) : null}

      <Card padded={false}>
        <div className="filter-bar">
          <Field label="Date" htmlFor="attendance-date">
            <Input id="attendance-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>

          <Field label="Department" htmlFor="attendance-department">
            <DepartmentSelector id="attendance-department" value={departmentId} onChange={setDepartmentId} />
          </Field>

          <Field label="Supervisor" htmlFor="attendance-supervisor">
            <SupervisorSelector id="attendance-supervisor" value={supervisorId} onChange={setSupervisorId} />
          </Field>

          <SearchInput value={search} onChange={setSearch} placeholder="Name or employee ID" />
        </div>

        {error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isFetching && employees.length === 0 ? (
          <Spinner label="Loading the attendance sheet" />
        ) : employees.length === 0 ? (
          <p className="muted" style={{ padding: '2rem', textAlign: 'center' }}>
            No employees match these filters for {formatDate(date)}.
          </p>
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table">
              <caption className="sr-only">Attendance for {formatDate(date)}</caption>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th className="hide-mobile">Department</th>
                  <th>Status</th>
                  <th>Leave type</th>
                  <th>Shift</th>
                  <th className="hide-mobile">Day</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((employee) => {
                  const current = statusFor(employee.employeeId, employee.status)
                  const isLeave = current === 'ON_LEAVE' || current === 'HALF_DAY_LEAVE'
                  const edited = Boolean(pending[employee.employeeId])

                  return (
                    <tr key={employee.employeeId} style={edited ? { background: 'var(--info-bg)' } : undefined}>
                      <td data-label="Employee">
                        <div>
                          <strong>{employee.employeeName}</strong>
                          <p className="subtle">
                            {employee.employeeCode}
                            {employee.supervisorName ? ` · ${employee.supervisorName}` : ''}
                          </p>
                        </div>
                      </td>
                      <td data-label="Department" className="hide-mobile">
                        {employee.departmentName ?? '—'}
                      </td>
                      <td data-label="Status">
                        {employee.isLocked ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                            <Lock size={13} aria-hidden />
                            <Badge tone="accent">{employee.status ?? 'Locked'}</Badge>
                          </span>
                        ) : canManage ? (
                          <Select
                            value={current}
                            aria-label={`Attendance status for ${employee.employeeName}`}
                            onChange={(event) => setStatus(employee.employeeId, event.target.value as AttendanceStatus)}
                          >
                            <option value="">Not marked</option>
                            {STATUS_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Badge tone="neutral">{employee.status ?? 'Not marked'}</Badge>
                        )}
                      </td>
                      <td data-label="Leave type">
                        {isLeave && canManage && !employee.isLocked ? (
                          <Select
                            value={pending[employee.employeeId]?.leaveTypeId ?? employee.leaveTypeId ?? ''}
                            aria-label={`Leave type for ${employee.employeeName}`}
                            onChange={(event) => setLeaveType(employee.employeeId, event.target.value, employee.status)}
                          >
                            <option value="">Select a leave type</option>
                            {(leaveTypes ?? []).map((leaveType) => (
                              <option key={leaveType.id} value={leaveType.id}>
                                {leaveType.name}
                                {leaveType.isPaid ? '' : ' (unpaid)'}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span className="subtle">{employee.leaveTypeName ?? '—'}</span>
                        )}
                      </td>
                      <td data-label="Shift">
                        {canManage && !employee.isLocked ? (
                          <Select
                            value={shiftFor(employee.employeeId, employee.shiftId)}
                            aria-label={`Shift for ${employee.employeeName}`}
                            onChange={(event) => setShift(employee.employeeId, event.target.value, employee.status)}
                          >
                            <option value="">No shift</option>
                            {(shifts ?? []).map((shift) => (
                              <option key={shift.id} value={shift.id}>
                                {shift.code} — {shift.name}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span className="subtle">{employee.shiftCode ?? '—'}</span>
                        )}
                      </td>
                      <td data-label="Day" className="hide-mobile">
                        {employee.dayKind === 'HOLIDAY' ? (
                          <Badge tone="accent">{employee.holidayName ?? 'Holiday'}</Badge>
                        ) : employee.dayKind === 'WEEKLY_OFF' ? (
                          <Badge tone="neutral">Weekly off</Badge>
                        ) : (
                          <span className="subtle">Working day</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <AttendanceImportModal open={importOpen} onClose={() => setImportOpen(false)} />

      <ConfirmDialog
        open={confirmCalendar}
        title="Apply calendar defaults"
        message={`Unmarked employees on ${formatDate(date)} will be marked as Holiday or Weekly Off according to the configured calendar. Days the calendar had marked as a holiday or weekly off that it no longer says are off (for example a deleted holiday) go back to not marked. Anything you marked yourself, approved leave and locked payroll days are left alone.`}
        confirmLabel="Apply"
        loading={calendarMutation.isPending}
        onConfirm={() => calendarMutation.mutate()}
        onCancel={() => setConfirmCalendar(false)}
      />
    </div>
  )
}
