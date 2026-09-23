import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { get, getWithMeta } from '../../lib/api'
import { formatDateTime, humanise } from '../../lib/format'
import { Badge, Card, Field, Input, Modal, PageHeader, Pagination, SearchInput, Select } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import type { AuditLogEntry } from '../../types/api'

/**
 * The audit trail (plan section 40).
 *
 * Read-only by design: entries are written by the API and never edited or
 * deleted from the interface.
 */
export default function AuditLogPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [action, setAction] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [detail, setDetail] = useState<AuditLogEntry | null>(null)

  const { data: actions } = useQuery({
    queryKey: ['audit-logs', 'actions'],
    queryFn: () => get<string[]>('/audit-logs/actions'),
    staleTime: 10 * 60 * 1000,
  })

  const filters = {
    page,
    pageSize: 50,
    search: search || undefined,
    action: action || undefined,
    from: from ? `${from}T00:00:00.000Z` : undefined,
    to: to ? `${to}T23:59:59.999Z` : undefined,
  }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['audit-logs', filters],
    queryFn: () => getWithMeta<AuditLogEntry[]>('/audit-logs', filters),
    placeholderData: keepPreviousData,
  })

  /** Financial and identity events are worth calling out visually. */
  const toneFor = (entry: string): 'danger' | 'warning' | 'info' | 'neutral' => {
    if (entry.includes('DELETED') || entry.includes('REVERSED') || entry.includes('FAILED')) return 'danger'
    if (entry.includes('PAYROLL') || entry.includes('PAYMENT') || entry.includes('SALARY')) return 'warning'
    if (entry.includes('SENSITIVE') || entry.includes('DOCUMENT')) return 'info'
    return 'neutral'
  }

  const columns: Column<AuditLogEntry>[] = [
    { key: 'time', header: 'When', render: (row) => formatDateTime(row.createdAt) },
    {
      key: 'action',
      header: 'Action',
      render: (row) => <Badge tone={toneFor(row.action)}>{humanise(row.action)}</Badge>,
    },
    {
      key: 'entity',
      header: 'Entity',
      render: (row) => (
        <div>
          <span>{humanise(row.entityType)}</span>
          {row.entityId ? <p className="subtle mono">{row.entityId.slice(0, 8)}</p> : null}
        </div>
      ),
    },
    {
      key: 'user',
      header: 'By',
      render: (row) => (
        <div>
          <span>{row.userName ?? 'System'}</span>
          {row.userEmail ? <p className="subtle">{row.userEmail}</p> : null}
        </div>
      ),
    },
    { key: 'ip', header: 'IP', hideOnMobile: true, render: (row) => <span className="mono">{row.ipAddress ?? '—'}</span> },
  ]

  return (
    <div className="page">
      <PageHeader
        title="Audit log"
        description="Every important change is recorded here, including who made it and from where."
      />

      <Card padded={false}>
        <div className="filter-bar">
          <SearchInput value={search} onChange={setSearch} placeholder="Action, entity or user" />

          <Field label="Action" htmlFor="audit-action">
            <Select
              id="audit-action"
              value={action}
              onChange={(event) => {
                setAction(event.target.value)
                setPage(1)
              }}
            >
              <option value="">All actions</option>
              {(actions ?? []).map((entry) => (
                <option key={entry} value={entry}>
                  {humanise(entry)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="From" htmlFor="audit-from">
            <Input id="audit-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>

          <Field label="To" htmlFor="audit-to">
            <Input id="audit-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
        </div>

        <DataTable
          columns={columns}
          rows={data?.data ?? []}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          onRowClick={(row) => setDetail(row)}
          emptyTitle="No audit entries match these filters"
          caption="Audit log"
        />

        {data?.meta ? (
          <Pagination
            page={data.meta.page ?? 1}
            pageSize={data.meta.pageSize ?? 50}
            total={data.meta.total ?? 0}
            totalPages={data.meta.totalPages ?? 1}
            onPageChange={setPage}
          />
        ) : null}
      </Card>

      <Modal
        open={detail !== null}
        title={detail ? humanise(detail.action) : ''}
        description={detail ? `${humanise(detail.entityType)} · ${formatDateTime(detail.createdAt)}` : undefined}
        size="lg"
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <div className="stack">
            <div className="breakdown-row">
              <span className="muted">By</span>
              <span>
                {detail.userName ?? 'System'}
                {detail.userEmail ? <span className="subtle"> · {detail.userEmail}</span> : null}
              </span>
            </div>
            <div className="breakdown-row">
              <span className="muted">IP address</span>
              <span className="mono">{detail.ipAddress ?? '—'}</span>
            </div>
            <div className="breakdown-row">
              <span className="muted">Entity id</span>
              <span className="mono">{detail.entityId ?? '—'}</span>
            </div>

            {detail.oldValues ? (
              <div>
                <p className="field-label">Before</p>
                <pre className="token-block">{JSON.stringify(detail.oldValues, null, 2)}</pre>
              </div>
            ) : null}

            {detail.newValues ? (
              <div>
                <p className="field-label">After</p>
                <pre className="token-block">{JSON.stringify(detail.newValues, null, 2)}</pre>
              </div>
            ) : null}

            <p className="subtle">
              Sensitive values such as identity and account numbers are redacted before they reach the audit log.
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
