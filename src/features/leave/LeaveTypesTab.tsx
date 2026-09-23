import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { get, patch, post } from '../../lib/api'
import { formatDays } from '../../lib/format'
import { useToast } from '../../app/providers/ToastProvider'
import { Badge, Button, Card, Field, Input, Modal, Select, StatusBadge } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import type { LeaveType } from '../../types/api'

/**
 * Leave type configuration.
 *
 * Whether a type is paid, and whether weekly offs and holidays inside a range
 * are consumed, are the settings the payroll engine reads - so they are data,
 * not assumptions (plan section 22).
 */

interface FormState {
  id?: string
  name: string
  code: string
  annualLimit: string
  isPaid: boolean
  requiresApproval: boolean
  allowHalfDay: boolean
  excludeWeeklyOff: boolean
  excludeHolidays: boolean
  sandwichHolidays: boolean
  requiresAttachment: boolean
  isActive: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  code: '',
  annualLimit: '',
  isPaid: true,
  requiresApproval: true,
  allowHalfDay: true,
  excludeWeeklyOff: true,
  excludeHolidays: true,
  sandwichHolidays: true,
  requiresAttachment: false,
  isActive: true,
}

export function LeaveTypesTab() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState | null>(null)

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['leave-types', 'all'],
    queryFn: () => get<LeaveType[]>('/leave/types', { activeOnly: 'false' }),
  })

  const mutation = useMutation({
    mutationFn: (values: FormState) => {
      const payload = {
        name: values.name,
        code: values.code.toUpperCase(),
        annualLimit: values.annualLimit === '' ? null : Number(values.annualLimit),
        isPaid: values.isPaid,
        requiresApproval: values.requiresApproval,
        allowHalfDay: values.allowHalfDay,
        excludeWeeklyOff: values.excludeWeeklyOff,
        excludeHolidays: values.excludeHolidays,
        requiresAttachment: values.requiresAttachment,
        isActive: values.isActive,
      }
      return values.id ? patch(`/leave/types/${values.id}`, payload) : post('/leave/types', payload)
    },
    onSuccess: async () => {
      toast.success('Leave type saved')
      setForm(null)
      await queryClient.invalidateQueries({ queryKey: ['leave-types'] })
    },
    onError: (mutationError: Error) => toast.error('Could not save', mutationError.message),
  })

  const columns: Column<LeaveType>[] = [
    {
      key: 'name',
      header: 'Leave type',
      render: (row) => (
        <div>
          <strong>{row.name}</strong>
          <p className="subtle">{row.code}</p>
        </div>
      ),
    },
    {
      key: 'paid',
      header: 'Paid',
      render: (row) => <Badge tone={row.isPaid ? 'success' : 'neutral'}>{row.isPaid ? 'Paid' : 'Unpaid'}</Badge>,
    },
    {
      key: 'limit',
      header: 'Annual limit',
      align: 'right',
      render: (row) => (row.annualLimit === null ? <span className="subtle">No limit</span> : formatDays(row.annualLimit)),
    },
    {
      key: 'rules',
      header: 'Rules',
      hideOnMobile: true,
      render: (row) => (
        <span className="subtle">
          {row.requiresApproval ? 'Needs approval' : 'Auto-approved'}
          {row.allowHalfDay ? ' · half day allowed' : ''}
          {row.excludeWeeklyOff ? ' · skips weekly offs' : ''}
          {row.excludeHolidays ? ' · skips holidays' : ''}
          {row.sandwichHolidays ? ' · sandwiched holidays charged' : ''}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setForm({
              id: row.id,
              name: row.name,
              code: row.code,
              annualLimit: row.annualLimit === null ? '' : String(row.annualLimit),
              isPaid: row.isPaid,
              requiresApproval: row.requiresApproval,
              allowHalfDay: row.allowHalfDay,
              excludeWeeklyOff: row.excludeWeeklyOff,
              excludeHolidays: row.excludeHolidays,
              sandwichHolidays: row.sandwichHolidays,
              requiresAttachment: row.requiresAttachment,
              isActive: row.isActive,
            })
          }
        >
          Edit
        </Button>
      ),
    },
  ]

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((current) => (current ? { ...current, [key]: value } : current))

  return (
    <Card
      title="Leave types"
      description="These settings drive both the leave workflow and how payroll values each leave day."
      actions={
        <Button size="sm" icon={<Plus size={14} />} onClick={() => setForm({ ...EMPTY_FORM })}>
          Add leave type
        </Button>
      }
      padded={false}
    >
      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(row) => row.id}
        loading={isFetching}
        error={error}
        onRetry={() => void refetch()}
        emptyTitle="No leave types yet"
        emptyDescription="Add the leave types your organization offers."
        caption="Leave types"
      />

      <Modal
        open={form !== null}
        title={form?.id ? 'Edit leave type' : 'Add leave type'}
        onClose={() => setForm(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button loading={mutation.isPending} onClick={() => form && mutation.mutate(form)} disabled={!form?.name || !form?.code}>
              Save
            </Button>
          </>
        }
      >
        {form ? (
          <div className="stack">
            <div className="grid grid-2">
              <Field label="Name" htmlFor="lt-name" required>
                <Input id="lt-name" value={form.name} onChange={(event) => update('name', event.target.value)} />
              </Field>
              <Field label="Code" htmlFor="lt-code" required hint="Short identifier, for example CL">
                <Input
                  id="lt-code"
                  value={form.code}
                  disabled={Boolean(form.id)}
                  style={{ textTransform: 'uppercase' }}
                  onChange={(event) => update('code', event.target.value.toUpperCase())}
                />
              </Field>
              <Field label="Annual limit" htmlFor="lt-limit" hint="Leave blank for no limit.">
                <Input
                  id="lt-limit"
                  type="number"
                  min="0"
                  step="0.5"
                  value={form.annualLimit}
                  onChange={(event) => update('annualLimit', event.target.value)}
                />
              </Field>
              <Field label="Paid" htmlFor="lt-paid" hint="Unpaid leave reduces paid days in payroll.">
                <Select id="lt-paid" value={form.isPaid ? 'true' : 'false'} onChange={(event) => update('isPaid', event.target.value === 'true')}>
                  <option value="true">Paid leave</option>
                  <option value="false">Unpaid leave</option>
                </Select>
              </Field>
            </div>

            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field-label">Rules</legend>
              <div className="stack" style={{ gap: '0.5rem', marginTop: '0.4rem' }}>
                <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <input type="checkbox" checked={form.requiresApproval} onChange={(event) => update('requiresApproval', event.target.checked)} />
                  <span>Requires supervisor approval</span>
                </label>
                <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <input type="checkbox" checked={form.allowHalfDay} onChange={(event) => update('allowHalfDay', event.target.checked)} />
                  <span>Half day allowed</span>
                </label>
                <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <input type="checkbox" checked={form.excludeWeeklyOff} onChange={(event) => update('excludeWeeklyOff', event.target.checked)} />
                  <span>Weekly offs inside the range do not consume leave</span>
                </label>
                <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <input type="checkbox" checked={form.excludeHolidays} onChange={(event) => update('excludeHolidays', event.target.checked)} />
                  <span>Holidays inside the range do not consume leave</span>
                </label>
                <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <input type="checkbox" checked={form.sandwichHolidays} onChange={(event) => update('sandwichHolidays', event.target.checked)} />
                  <span>
                    Sandwich rule: a holiday with leave on the day before and the day after is charged as leave, even
                    when the leave either side is a separate request
                  </span>
                </label>
                <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <input type="checkbox" checked={form.requiresAttachment} onChange={(event) => update('requiresAttachment', event.target.checked)} />
                  <span>Requires a supporting document</span>
                </label>
                <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <input type="checkbox" checked={form.isActive} onChange={(event) => update('isActive', event.target.checked)} />
                  <span>Active</span>
                </label>
              </div>
            </fieldset>
          </div>
        ) : null}
      </Modal>
    </Card>
  )
}
