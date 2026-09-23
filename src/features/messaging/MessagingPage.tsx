import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Send, Wand2 } from 'lucide-react'
import { get, getWithMeta, patch, post } from '../../lib/api'
import { formatRelative, humanise } from '../../lib/format'
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
  Select,
  Spinner,
  StatusBadge,
  Tabs,
  Textarea,
} from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'

/**
 * Messaging.
 *
 * WhatsApp refuses free-form business-initiated messages: anything sent outside
 * the 24-hour window after someone writes to us has to use a template the
 * provider approved first. So a scenario here is a switch plus the name of that
 * template - not a box to type a message into.
 */

interface MessageTemplate {
  name: string
  language: string
  category: string
  body: string
  variables: string[]
}

interface TemplateEntry extends MessageTemplate {
  /** Null for the template used by "Send a message". */
  eventKey: string | null
  forName: string
}

interface Scenario {
  id: string
  eventKey: string
  name: string
  description: string | null
  whatsappEnabled: boolean
  templateName: string | null
  templateLanguage: string
  templateVariables: string[]
  availableVariables: string[]
  suggestedTemplate: MessageTemplate | null
  isReady: boolean
}

interface OutboxEntry {
  id: string
  eventKey: string | null
  recipientName: string | null
  recipientPhone: string | null
  templateName: string | null
  preview: string | null
  status: string
  statusReason: string | null
  createdAt: string
}

interface Broadcast {
  id: string
  title: string
  body: string
  templateName: string | null
  sendInApp: boolean
  sendWhatsapp: boolean
  recipientCount: number
  sentCount: number
  failedCount: number
  createdAt: string
  createdByName: string | null
}

interface UserRow {
  id: string
  fullName: string
  email: string
  role: string
}

interface DeliveryStatus {
  driver: string
  live: boolean
  detail: string
}

const VARIABLE_LABELS: Record<string, string> = {
  recipientName: "the person's name",
  title: 'the message title',
  body: 'the message text',
}

function useTemplates() {
  return useQuery({
    queryKey: ['messaging', 'templates'],
    queryFn: () => get<TemplateEntry[]>('/messaging/templates'),
    staleTime: 10 * 60 * 1000,
  })
}

async function copyText(text: string, toast: ReturnType<typeof useToast>, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error('Could not copy', 'Select the text and copy it by hand.')
  }
}

export default function MessagingPage() {
  const { can } = useAuth()
  const [tab, setTab] = useState('scenarios')

  const { data: status } = useQuery({
    queryKey: ['messaging', 'status'],
    queryFn: () => get<DeliveryStatus>('/messaging/status'),
  })

  return (
    <div className="page">
      <PageHeader
        title="Messaging"
        description="Which events send a WhatsApp message, and what has actually gone out."
      />

      {status && !status.live ? (
        <Card>
          <div className="row" style={{ gap: '0.6rem', alignItems: 'flex-start' }}>
            <Badge tone="warning">Not sending</Badge>
            <p className="subtle" style={{ margin: 0 }}>
              {status.detail}
            </p>
          </div>
        </Card>
      ) : null}

      <Tabs
        tabs={[
          { key: 'scenarios', label: 'Scenarios' },
          { key: 'templates', label: 'Templates' },
          ...(can('message.broadcast') ? [{ key: 'broadcast', label: 'Send a message' }] : []),
          { key: 'log', label: 'Delivery log' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'scenarios' ? <ScenariosTab canManage={can('message.manage')} /> : null}
      {tab === 'templates' ? <TemplatesTab /> : null}
      {tab === 'broadcast' ? <BroadcastTab /> : null}
      {tab === 'log' ? <DeliveryLogTab /> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function ScenariosTab({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<Scenario | null>(null)
  const [form, setForm] = useState({ templateName: '', templateLanguage: 'en', whatsappEnabled: false })

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['messaging', 'scenarios'],
    queryFn: () => get<Scenario[]>('/messaging/scenarios'),
  })

  const save = useMutation({
    mutationFn: () =>
      patch(`/messaging/scenarios/${editing?.id}`, {
        whatsappEnabled: form.whatsappEnabled,
        templateName: form.templateName.trim() === '' ? null : form.templateName.trim(),
        templateLanguage: form.templateLanguage,
      }),
    onSuccess: async () => {
      toast.success('Scenario updated')
      setEditing(null)
      await queryClient.invalidateQueries({ queryKey: ['messaging', 'scenarios'] })
    },
    onError: (mutationError: Error) => toast.error('Could not save', mutationError.message),
  })

  const applySuggested = useMutation({
    mutationFn: () => post<{ updated: number }>('/messaging/scenarios/apply-templates'),
    onSuccess: async (response) => {
      toast.success(response.message ?? 'Templates named')
      await queryClient.invalidateQueries({ queryKey: ['messaging', 'scenarios'] })
    },
    onError: (mutationError: Error) => toast.error('Could not name the templates', mutationError.message),
  })

  const toggle = useMutation({
    mutationFn: (scenario: Scenario) =>
      patch(`/messaging/scenarios/${scenario.id}`, { whatsappEnabled: !scenario.whatsappEnabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['messaging', 'scenarios'] })
    },
    onError: (mutationError: Error) => toast.error('Could not change this scenario', mutationError.message),
  })

  const columns: Column<Scenario>[] = [
    {
      key: 'name',
      header: 'Event',
      render: (row) => (
        <div>
          <strong>{row.name}</strong>
          <p className="subtle">{row.description}</p>
        </div>
      ),
    },
    {
      key: 'template',
      header: 'WhatsApp template',
      render: (row) =>
        row.templateName ? (
          <code>{row.templateName}</code>
        ) : (
          <span className="subtle">Not set</span>
        ),
    },
    {
      key: 'state',
      header: 'WhatsApp',
      render: (row) =>
        row.isReady ? (
          <StatusBadge status="ACTIVE" />
        ) : row.whatsappEnabled ? (
          <Badge tone="warning">Needs a template</Badge>
        ) : (
          <Badge tone="neutral">Off</Badge>
        ),
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            render: (row: Scenario) => (
              <div style={{ display: 'inline-flex', gap: '0.3rem' }}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!row.templateName && !row.whatsappEnabled}
                  onClick={() => toggle.mutate(row)}
                >
                  {row.whatsappEnabled ? 'Turn off' : 'Turn on'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setForm({
                      templateName: row.templateName ?? '',
                      templateLanguage: row.templateLanguage,
                      whatsappEnabled: row.whatsappEnabled,
                    })
                    setEditing(row)
                  }}
                >
                  Configure
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ]

  return (
    <Card
      title="Scenarios"
      description="Each event can send one WhatsApp message. Register its template with WhatsApp (see the Templates tab), then turn it on."
      padded={false}
      actions={
        canManage ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Wand2 size={14} />}
            loading={applySuggested.isPending}
            onClick={() => applySuggested.mutate()}
          >
            Use suggested template names
          </Button>
        ) : null
      }
    >
      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(row) => row.id}
        loading={isFetching}
        error={error}
        onRetry={() => void refetch()}
        emptyTitle="No scenarios yet"
        caption="Message scenarios"
      />

      <Modal
        open={editing !== null}
        title={editing ? editing.name : ''}
        description="The template must already be approved in your WhatsApp Business account."
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field
            label="Template name"
            htmlFor="tpl-name"
            hint="Lower-case letters, digits and underscores, exactly as registered."
          >
            <Input
              id="tpl-name"
              value={form.templateName}
              placeholder="leave_approved"
              onChange={(event) => setForm({ ...form, templateName: event.target.value.toLowerCase() })}
            />
          </Field>
          <Field label="Language" htmlFor="tpl-lang" hint="The template's language code, for example en or en_US.">
            <Input
              id="tpl-lang"
              value={form.templateLanguage}
              onChange={(event) => setForm({ ...form, templateLanguage: event.target.value })}
            />
          </Field>

          {editing?.suggestedTemplate ? (
            <Field
              label="Suggested template"
              hint="Register this text with WhatsApp under the name shown, then use it here."
            >
              <div className="stack" style={{ gap: '0.5rem' }}>
                <p style={{ margin: 0 }}>{editing.suggestedTemplate.body}</p>
                <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setForm({
                        ...form,
                        templateName: editing.suggestedTemplate?.name ?? form.templateName,
                        templateLanguage: editing.suggestedTemplate?.language ?? form.templateLanguage,
                      })
                    }
                  >
                    Use <code>{editing.suggestedTemplate.name}</code>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Copy size={13} />}
                    onClick={() => void copyText(editing.suggestedTemplate?.body ?? '', toast, 'Template text')}
                  >
                    Copy text
                  </Button>
                </div>
              </div>
            </Field>
          ) : null}

          {editing ? (
            <Field label="Placeholders" hint="Filled in this order.">
              <p className="subtle" style={{ margin: 0 }}>
                {editing.templateVariables.map((name, index) => (
                  <span key={name}>
                    {index > 0 ? ' · ' : ''}
                    <code>{`{{${index + 1}}}`}</code> {name}
                  </span>
                ))}
              </p>
            </Field>
          ) : null}

          <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={form.whatsappEnabled}
              onChange={(event) => setForm({ ...form, whatsappEnabled: event.target.checked })}
            />
            <span>Send a WhatsApp message for this event</span>
          </label>
        </div>
      </Modal>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function TemplatesTab() {
  const toast = useToast()
  const { data, isFetching, error, refetch } = useTemplates()

  const columns: Column<TemplateEntry>[] = [
    {
      key: 'for',
      header: 'Message',
      render: (row) => (
        <div>
          <strong>{row.forName}</strong>
          <p className="subtle">
            <code>{row.name}</code> · {row.language} · {row.category}
          </p>
        </div>
      ),
    },
    {
      key: 'body',
      header: 'Template text',
      render: (row) => (
        <div>
          <span>{row.body}</span>
          <p className="subtle">
            {row.variables.map((name, index) => (
              <span key={name}>
                {index > 0 ? ' · ' : ''}
                <code>{`{{${index + 1}}}`}</code> {VARIABLE_LABELS[name] ?? name}
              </span>
            ))}
          </p>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div style={{ display: 'inline-flex', gap: '0.3rem' }}>
          <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => void copyText(row.name, toast, 'Template name')}>
            Name
          </Button>
          <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => void copyText(row.body, toast, 'Template text')}>
            Text
          </Button>
        </div>
      ),
    },
  ]

  return (
    <Card
      title="WhatsApp templates"
      description="WhatsApp only delivers a business message from a template it has approved. Create each one below in your WhatsApp Business account (category Utility, language English) using exactly this name and text, then turn its scenario on."
      padded={false}
    >
      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(row) => row.eventKey ?? 'broadcast'}
        loading={isFetching}
        error={error}
        onRetry={() => void refetch()}
        emptyTitle="No templates"
        caption="WhatsApp templates"
      />
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

function BroadcastTab() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string[]>([])
  const [roleFilter, setRoleFilter] = useState('')
  const [form, setForm] = useState({
    title: '',
    body: '',
    sendInApp: true,
    sendWhatsapp: false,
    templateName: '',
    templateLanguage: 'en',
  })

  const { data: users } = useQuery({
    queryKey: ['messaging', 'recipients', roleFilter],
    queryFn: () => getWithMeta<UserRow[]>('/users', { role: roleFilter || undefined, pageSize: 200 }),
  })

  const { data: templates } = useTemplates()
  const broadcastTemplate = templates?.find((entry) => entry.eventKey === null)

  const { data: history } = useQuery({
    queryKey: ['messaging', 'broadcasts'],
    queryFn: () => get<Broadcast[]>('/messaging/broadcasts'),
  })

  const candidates = useMemo(() => users?.data ?? [], [users])
  const allSelected = candidates.length > 0 && selected.length === candidates.length

  const send = useMutation({
    mutationFn: () =>
      post('/messaging/broadcasts', {
        title: form.title,
        body: form.body,
        userIds: selected,
        sendInApp: form.sendInApp,
        sendWhatsapp: form.sendWhatsapp,
        templateName: form.sendWhatsapp ? form.templateName.trim() || null : null,
        templateLanguage: form.templateLanguage,
      }),
    onSuccess: async (response) => {
      toast.success(response.message ?? 'Message sent')
      setForm({ ...form, title: '', body: '' })
      setSelected([])
      await queryClient.invalidateQueries({ queryKey: ['messaging'] })
    },
    onError: (error: Error) => toast.error('Could not send', error.message),
  })

  const canSend =
    form.title.trim().length > 1 &&
    form.body.trim().length > 1 &&
    selected.length > 0 &&
    (!form.sendWhatsapp || form.templateName.trim().length > 0)

  return (
    <div className="stack">
      <Card title="Send a message" description="Goes to the people you choose, in the app and optionally on WhatsApp.">
        <div className="stack">
          <div className="grid grid-2">
            <Field label="Title" htmlFor="bc-title" required>
              <Input
                id="bc-title"
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
              />
            </Field>
            <Field label="Role" htmlFor="bc-role" hint="Narrows the list below.">
              <Select id="bc-role" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
                <option value="">Everyone</option>
                <option value="SUPER_ADMIN">Super Admin</option>
                <option value="SUPERVISOR">Supervisor</option>
                <option value="EMPLOYEE">Employee</option>
              </Select>
            </Field>
          </div>

          <Field label="Message" htmlFor="bc-body" required>
            <Textarea
              id="bc-body"
              rows={3}
              value={form.body}
              onChange={(event) => setForm({ ...form, body: event.target.value })}
            />
          </Field>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">Channels</legend>
            <div className="stack" style={{ gap: '0.5rem', marginTop: '0.4rem' }}>
              <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={form.sendInApp}
                  onChange={(event) => setForm({ ...form, sendInApp: event.target.checked })}
                />
                <span>In the app</span>
              </label>
              <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={form.sendWhatsapp}
                  onChange={(event) => setForm({ ...form, sendWhatsapp: event.target.checked })}
                />
                <span>On WhatsApp</span>
              </label>
            </div>
          </fieldset>

          {form.sendWhatsapp ? (
            <Field
              label="Template name"
              htmlFor="bc-template"
              required
              hint="WhatsApp will not deliver a business-initiated message without an approved template."
            >
              <div className="stack" style={{ gap: '0.4rem' }}>
                <Input
                  id="bc-template"
                  value={form.templateName}
                  placeholder="skt_announcement"
                  onChange={(event) => setForm({ ...form, templateName: event.target.value.toLowerCase() })}
                />
                {broadcastTemplate ? (
                  <div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setForm({ ...form, templateName: broadcastTemplate.name, templateLanguage: broadcastTemplate.language })}
                    >
                      Use suggested <code>{broadcastTemplate.name}</code>
                    </Button>
                    <p className="field-message">{broadcastTemplate.body}</p>
                  </div>
                ) : null}
              </div>
            </Field>
          ) : null}

          <Field label={`Recipients (${selected.length} selected)`}>
            <div
              style={{
                maxHeight: 220,
                overflowY: 'auto',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '0.5rem 0.7rem',
              }}
            >
              <label className="row" style={{ gap: '0.5rem', alignItems: 'center', paddingBottom: '0.35rem' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(event) => setSelected(event.target.checked ? candidates.map((u) => u.id) : [])}
                />
                <strong>Select everyone shown</strong>
              </label>
              {candidates.map((user) => (
                <label key={user.id} className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={selected.includes(user.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id),
                      )
                    }
                  />
                  <span>
                    {user.fullName} <span className="subtle">· {humanise(user.role)}</span>
                  </span>
                </label>
              ))}
              {candidates.length === 0 ? <p className="subtle">Nobody matches this filter.</p> : null}
            </div>
          </Field>

          <div>
            <Button icon={<Send size={15} />} loading={send.isPending} disabled={!canSend} onClick={() => send.mutate()}>
              Send to {selected.length || 'no one'}
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Recently sent" padded={false}>
        <DataTable
          columns={[
            { key: 'title', header: 'Message', render: (row: Broadcast) => <strong>{row.title}</strong> },
            {
              key: 'channels',
              header: 'Channels',
              render: (row: Broadcast) => (
                <span className="subtle">
                  {[row.sendInApp ? 'In app' : null, row.sendWhatsapp ? 'WhatsApp' : null].filter(Boolean).join(' · ')}
                </span>
              ),
            },
            {
              key: 'counts',
              header: 'Delivered',
              align: 'right',
              render: (row: Broadcast) => `${row.sentCount} / ${row.recipientCount}`,
            },
            {
              key: 'when',
              header: 'Sent',
              hideOnMobile: true,
              render: (row: Broadcast) => <span className="subtle">{formatRelative(row.createdAt)}</span>,
            },
          ]}
          rows={history ?? []}
          rowKey={(row) => row.id}
          emptyTitle="Nothing sent yet"
          caption="Broadcasts"
        />
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------------

function DeliveryLogTab() {
  const [status, setStatus] = useState('')

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['messaging', 'outbox', status],
    queryFn: () => getWithMeta<OutboxEntry[]>('/messaging/outbox', { status: status || undefined, pageSize: 50 }),
  })

  const columns: Column<OutboxEntry>[] = [
    {
      key: 'recipient',
      header: 'To',
      render: (row) => (
        <div>
          <strong>{row.recipientName ?? 'Unknown'}</strong>
          <p className="subtle">{row.recipientPhone ?? 'No number'}</p>
        </div>
      ),
    },
    {
      key: 'what',
      header: 'Message',
      render: (row) => (
        <div>
          <span>{row.preview ?? '—'}</span>
          <p className="subtle">
            {row.eventKey ? humanise(row.eventKey) : 'Broadcast'}
            {row.templateName ? ` · ${row.templateName}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div>
          <StatusBadge status={row.status} />
          {row.statusReason ? <p className="subtle">{row.statusReason}</p> : null}
        </div>
      ),
    },
    {
      key: 'when',
      header: 'When',
      hideOnMobile: true,
      render: (row) => <span className="subtle">{formatRelative(row.createdAt)}</span>,
    },
  ]

  return (
    <Card title="Delivery log" description="Every WhatsApp message attempted, including the ones that were not sent." padded={false}>
      <div className="filter-bar">
        <Field label="Status" htmlFor="log-status">
          <Select id="log-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All</option>
            <option value="SENT">Sent</option>
            <option value="FAILED">Failed</option>
            <option value="SKIPPED">Skipped</option>
          </Select>
        </Field>
      </div>

      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(row) => row.id}
        loading={isFetching}
        error={error}
        onRetry={() => void refetch()}
        emptyTitle="Nothing sent yet"
        emptyDescription="Messages appear here as soon as a scenario fires or a broadcast goes out."
        caption="Delivery log"
      />
    </Card>
  )
}
