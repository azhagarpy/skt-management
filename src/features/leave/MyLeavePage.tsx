import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarPlus } from 'lucide-react'
import { get, getWithMeta, post } from '../../lib/api'
import { formatDate, formatDays } from '../../lib/format'
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
  StatTile,
  StatusBadge,
  Textarea,
} from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { LeaveTypeSelector, useLeaveTypes } from '../../components/forms/selectors'
import type { LeaveBalance, LeaveRequest } from '../../types/api'

/** Employee self-service leave: balances, history and applying for leave. */
export default function MyLeavePage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const year = new Date().getFullYear()

  const [applying, setApplying] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<LeaveRequest | null>(null)
  const [form, setForm] = useState({
    leaveTypeId: '',
    fromDate: '',
    toDate: '',
    dayPortion: 'FULL_DAY' as 'FULL_DAY' | 'HALF_DAY',
    reason: '',
  })

  const { data: leaveTypes } = useLeaveTypes()

  const { data: balances } = useQuery({
    queryKey: ['leave', 'balances', 'me', year],
    queryFn: () => get<LeaveBalance[]>('/leave/balances', { employeeId: 'me', year }),
  })

  const { data: requests, isFetching, error, refetch } = useQuery({
    queryKey: ['leave', 'requests', 'me'],
    queryFn: () =>
      getWithMeta<LeaveRequest[]>('/leave/requests', {
        employeeId: 'me',
        pageSize: 50,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      }),
  })

  const applyMutation = useMutation({
    mutationFn: () =>
      post('/leave/requests', {
        leaveTypeId: form.leaveTypeId,
        fromDate: form.fromDate,
        toDate: form.dayPortion === 'HALF_DAY' ? form.fromDate : form.toDate,
        dayPortion: form.dayPortion,
        reason: form.reason,
      }),
    onSuccess: async () => {
      toast.success('Leave request submitted')
      setApplying(false)
      setForm({ leaveTypeId: '', fromDate: '', toDate: '', dayPortion: 'FULL_DAY', reason: '' })
      await queryClient.invalidateQueries({ queryKey: ['leave'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (mutationError: Error) => toast.error('Could not submit the request', mutationError.message),
  })

  const cancelMutation = useMutation({
    mutationFn: (request: LeaveRequest) => post(`/leave/requests/${request.id}/cancel`, { reason: 'Cancelled by employee' }),
    onSuccess: async () => {
      toast.success('Leave request cancelled')
      setCancelTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['leave'] })
    },
    onError: (mutationError: Error) => {
      setCancelTarget(null)
      toast.error('Could not cancel', mutationError.message)
    },
  })

  const selectedType = leaveTypes?.find((type) => type.id === form.leaveTypeId)
  const isHalfDayAllowed = selectedType?.allowHalfDay !== false

  const columns: Column<LeaveRequest>[] = [
    {
      key: 'type',
      header: 'Leave type',
      render: (row) => (
        <span>
          {row.leaveTypeName} {row.isPaid ? null : <Badge tone="neutral">Unpaid</Badge>}
        </span>
      ),
    },
    {
      key: 'dates',
      header: 'Dates',
      render: (row) => (
        <span>
          {formatDate(row.fromDate)}
          {row.fromDate !== row.toDate ? ` → ${formatDate(row.toDate)}` : ''}
          {row.dayPortion === 'HALF_DAY' ? <Badge tone="info">Half day</Badge> : null}
        </span>
      ),
    },
    { key: 'days', header: 'Days', align: 'right', render: (row) => formatDays(row.totalDays) },
    { key: 'reason', header: 'Reason', hideOnMobile: true, render: (row) => <span className="subtle">{row.reason}</span> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'decision',
      header: 'Decision',
      hideOnMobile: true,
      render: (row) =>
        row.decisionComment ? (
          <span className="subtle">
            {row.decidedByName ? `${row.decidedByName}: ` : ''}
            {row.decisionComment}
          </span>
        ) : (
          <span className="subtle">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) =>
        row.status === 'PENDING' || row.status === 'APPROVED' ? (
          <Button size="sm" variant="ghost" onClick={() => setCancelTarget(row)}>
            Cancel
          </Button>
        ) : null,
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="My leave"
        description="Your balances and requests."
        actions={
          <Button icon={<CalendarPlus size={15} />} onClick={() => setApplying(true)}>
            Apply for leave
          </Button>
        }
      />

      <div className="grid grid-4">
        {(balances ?? []).map((balance) => (
          <StatTile
            key={balance.id}
            label={balance.leaveTypeName ?? 'Leave'}
            value={formatDays(balance.available)}
            sublabel={`${formatDays(balance.used)} used · ${formatDays(balance.entitled)} entitled`}
            tone={balance.available > 0 ? 'success' : 'neutral'}
          />
        ))}
      </div>

      <Card title="My requests" padded={false}>
        <DataTable
          columns={columns}
          rows={requests?.data ?? []}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          emptyTitle="No leave requests yet"
          emptyDescription="Apply for leave and it will appear here."
          caption="My leave requests"
        />
      </Card>

      <Modal
        open={applying}
        title="Apply for leave"
        description="Weekly offs and holidays inside the range may not consume leave, depending on the leave type."
        onClose={() => setApplying(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setApplying(false)}>
              Cancel
            </Button>
            <Button
              loading={applyMutation.isPending}
              disabled={!form.leaveTypeId || !form.fromDate || (form.dayPortion === 'FULL_DAY' && !form.toDate) || form.reason.trim().length < 3}
              onClick={() => applyMutation.mutate()}
            >
              Submit request
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="Leave type" htmlFor="leaveTypeId" required>
            <LeaveTypeSelector
              id="leaveTypeId"
              value={form.leaveTypeId}
              onChange={(value) => setForm((current) => ({ ...current, leaveTypeId: value }))}
              required
            />
          </Field>

          {selectedType && !selectedType.isPaid ? (
            <div className="alert alert-warning">
              {selectedType.name} is unpaid: these days will not be paid in payroll.
            </div>
          ) : null}

          <Field label="Duration" htmlFor="dayPortion">
            <Select
              id="dayPortion"
              value={form.dayPortion}
              disabled={!isHalfDayAllowed}
              onChange={(event) =>
                setForm((current) => ({ ...current, dayPortion: event.target.value as 'FULL_DAY' | 'HALF_DAY' }))
              }
            >
              <option value="FULL_DAY">Full day(s)</option>
              {isHalfDayAllowed ? <option value="HALF_DAY">Half day</option> : null}
            </Select>
          </Field>

          <div className="grid grid-2">
            <Field label={form.dayPortion === 'HALF_DAY' ? 'Date' : 'From date'} htmlFor="fromDate" required>
              <Input
                id="fromDate"
                type="date"
                value={form.fromDate}
                onChange={(event) => setForm((current) => ({ ...current, fromDate: event.target.value }))}
              />
            </Field>

            {form.dayPortion === 'FULL_DAY' ? (
              <Field label="To date" htmlFor="toDate" required>
                <Input
                  id="toDate"
                  type="date"
                  value={form.toDate}
                  min={form.fromDate || undefined}
                  onChange={(event) => setForm((current) => ({ ...current, toDate: event.target.value }))}
                />
              </Field>
            ) : null}
          </div>

          <Field label="Reason" htmlFor="reason" required>
            <Textarea
              id="reason"
              value={form.reason}
              onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))}
            />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={cancelTarget !== null}
        title="Cancel leave request"
        message={
          cancelTarget?.status === 'APPROVED'
            ? 'This request is already approved. Cancelling will also reverse the attendance it created, unless payroll has already used those days.'
            : 'This request will be cancelled and the reserved balance released.'
        }
        confirmLabel="Cancel request"
        tone="danger"
        loading={cancelMutation.isPending}
        onConfirm={() => cancelTarget && cancelMutation.mutate(cancelTarget)}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  )
}
