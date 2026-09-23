import { useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Plus, X } from 'lucide-react'
import { get, getWithMeta, post } from '../../lib/api'
import { formatDate, formatDays } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Select,
  StatTile,
  StatusBadge,
  Tabs,
  Textarea,
} from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { DepartmentSelector } from '../../components/forms/selectors'
import { LeaveTypesTab } from './LeaveTypesTab'
import type { LeaveRequest } from '../../types/api'

/**
 * Leave administration: the request queue plus leave type configuration
 * (plan section 10).
 */
export default function LeavePage() {
  const { can } = useAuth()
  const toast = useToast()
  const queryClient = useQueryClient()

  const [tab, setTab] = useState('requests')
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('PENDING')
  const [departmentId, setDepartmentId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [decision, setDecision] = useState<{ request: LeaveRequest; action: 'approve' | 'reject' } | null>(null)
  const [comment, setComment] = useState('')

  const canApprove = can('leave.approve.all') || can('leave.approve.team')
  const canManageTypes = can('leave.type.manage')

  const filters = {
    page,
    pageSize: 25,
    status: status || undefined,
    departmentId: departmentId || undefined,
    from: from || undefined,
    to: to || undefined,
    sortBy: 'createdAt',
    sortOrder: 'desc' as const,
  }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['leave', 'requests', filters],
    queryFn: () => getWithMeta<LeaveRequest[]>('/leave/requests', filters),
    placeholderData: keepPreviousData,
    enabled: tab === 'requests',
  })

  const { data: pendingCount } = useQuery({
    queryKey: ['leave', 'requests', 'pending-count'],
    queryFn: () => getWithMeta<LeaveRequest[]>('/leave/requests', { status: 'PENDING', pageSize: 1 }),
    select: (response) => response.meta?.total ?? 0,
  })

  const decisionMutation = useMutation({
    mutationFn: ({ request, action, text }: { request: LeaveRequest; action: 'approve' | 'reject'; text: string }) =>
      post(`/leave/requests/${request.id}/${action}`, action === 'reject' ? { comment: text } : { comment: text || undefined }),
    onSuccess: async (_result, variables) => {
      toast.success(variables.action === 'approve' ? 'Leave approved' : 'Leave rejected')
      setDecision(null)
      setComment('')
      await queryClient.invalidateQueries({ queryKey: ['leave'] })
      await queryClient.invalidateQueries({ queryKey: ['attendance'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (mutationError: Error) => toast.error('Could not record the decision', mutationError.message),
  })

  const rows = data?.data ?? []
  const meta = data?.meta

  const columns: Column<LeaveRequest>[] = [
    {
      key: 'employee',
      header: 'Employee',
      render: (row) => (
        <div>
          <strong>{row.employeeName}</strong>
          <p className="subtle">
            {row.employeeCode}
            {row.departmentName ? ` · ${row.departmentName}` : ''}
          </p>
        </div>
      ),
    },
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
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (row) =>
        canApprove && row.status === 'PENDING' ? (
          <div style={{ display: 'inline-flex', gap: '0.35rem' }}>
            <Button
              size="sm"
              variant="secondary"
              icon={<Check size={13} />}
              onClick={(event) => {
                event.stopPropagation()
                setDecision({ request: row, action: 'approve' })
              }}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<X size={13} />}
              onClick={(event) => {
                event.stopPropagation()
                setDecision({ request: row, action: 'reject' })
              }}
            >
              Reject
            </Button>
          </div>
        ) : (
          <span className="subtle">{row.decidedByName ?? '—'}</span>
        ),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="Leave"
        description="Review leave requests. Approving a request writes the matching attendance automatically."
      />

      <Tabs
        tabs={[
          { key: 'requests', label: 'Requests', count: pendingCount ?? undefined },
          ...(canManageTypes ? [{ key: 'types', label: 'Leave types' }] : []),
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'requests' ? (
        <>
          <div className="grid grid-4">
            <StatTile label="Pending" value={pendingCount ?? 0} tone={pendingCount ? 'warning' : 'neutral'} />
            <StatTile label="Showing" value={meta?.total ?? 0} sublabel={status ? status.toLowerCase() : 'all statuses'} tone="info" />
          </div>

          <Card padded={false}>
            <div className="filter-bar">
              <Field label="Status" htmlFor="leave-status">
                <Select
                  id="leave-status"
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value)
                    setPage(1)
                  }}
                >
                  <option value="">All statuses</option>
                  <option value="PENDING">Pending</option>
                  <option value="APPROVED">Approved</option>
                  <option value="REJECTED">Rejected</option>
                  <option value="CANCELLED">Cancelled</option>
                </Select>
              </Field>

              <Field label="Department" htmlFor="leave-department">
                <DepartmentSelector
                  id="leave-department"
                  value={departmentId}
                  onChange={(value) => {
                    setDepartmentId(value)
                    setPage(1)
                  }}
                />
              </Field>

              <Field label="From" htmlFor="leave-from">
                <Input id="leave-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
              </Field>

              <Field label="To" htmlFor="leave-to">
                <Input id="leave-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
              </Field>
            </div>

            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              loading={isFetching}
              error={error}
              onRetry={() => void refetch()}
              emptyTitle="No leave requests"
              emptyDescription="Nothing matches these filters."
              caption="Leave requests"
            />

            {meta ? (
              <Pagination
                page={meta.page ?? 1}
                pageSize={meta.pageSize ?? 25}
                total={meta.total ?? 0}
                totalPages={meta.totalPages ?? 1}
                onPageChange={setPage}
              />
            ) : null}
          </Card>
        </>
      ) : (
        <LeaveTypesTab />
      )}

      <Modal
        open={decision !== null}
        title={decision?.action === 'approve' ? 'Approve leave' : 'Reject leave'}
        description={
          decision
            ? `${decision.request.employeeName} · ${decision.request.leaveTypeName} · ${formatDays(decision.request.totalDays)} day(s)`
            : undefined
        }
        onClose={() => {
          setDecision(null)
          setComment('')
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDecision(null)
                setComment('')
              }}
            >
              Cancel
            </Button>
            <Button
              variant={decision?.action === 'reject' ? 'danger' : 'primary'}
              loading={decisionMutation.isPending}
              disabled={decision?.action === 'reject' && comment.trim().length < 3}
              onClick={() =>
                decision && decisionMutation.mutate({ request: decision.request, action: decision.action, text: comment })
              }
            >
              {decision?.action === 'approve' ? 'Approve' : 'Reject'}
            </Button>
          </>
        }
      >
        <div className="stack">
          {decision?.action === 'approve' ? (
            <p className="muted">
              Approving writes {formatDays(decision.request.totalDays)} day(s) of attendance for{' '}
              {formatDate(decision.request.fromDate)}
              {decision.request.fromDate !== decision.request.toDate ? ` to ${formatDate(decision.request.toDate)}` : ''}.
            </p>
          ) : null}

          <Field
            label={decision?.action === 'reject' ? 'Reason for rejection' : 'Comment'}
            htmlFor="decision-comment"
            required={decision?.action === 'reject'}
            hint={decision?.action === 'reject' ? 'The employee will see this.' : 'Optional.'}
          >
            <Textarea id="decision-comment" value={comment} onChange={(event) => setComment(event.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
