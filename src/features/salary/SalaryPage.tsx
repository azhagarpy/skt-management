import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { del, get, post, put } from '../../lib/api'
import { formatCurrency, formatDate, humanise } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
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
  StatusBadge,
  Tabs,
} from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { EmployeeSelector, useSalaryStructures } from '../../components/forms/selectors'
import type { SalaryComponent, SalaryStructure } from '../../types/api'

/**
 * Salary configuration: components, structures, and assigning a salary to an
 * employee. PF and ESI are a fixed rule (no wage ceiling for PF, no ESI above
 * Rs 21,000) with rates that live on each structure - there is no separate
 * statutory rule engine or payroll policy to configure.
 */
export default function SalaryPage() {
  const { can } = useAuth()
  const [tab, setTab] = useState('structures')
  const canManageStructures = can('salary.structure.manage')

  const tabs = [
    { key: 'structures', label: 'Structures' },
    { key: 'components', label: 'Components' },
    ...(can('salary.manage') ? [{ key: 'assign', label: 'Assign salary' }] : []),
    ...(canManageStructures ? [{ key: 'pf-esi', label: 'PF, ESI & policy' }] : []),
  ]

  return (
    <div className="page">
      <PageHeader
        title="Salary"
        description="Structures define the shape of a salary; each employee's amount and effective dates are assigned on top."
      />

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'structures' ? <StructuresTab canManage={canManageStructures} /> : null}
      {tab === 'components' ? <ComponentsTab canManage={canManageStructures} /> : null}
      {tab === 'assign' ? <AssignTab /> : null}
      {tab === 'pf-esi' && canManageStructures ? <PfEsiTab /> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

interface StructureForm {
  name: string
  code: string
  salaryBasis: 'MONTHLY' | 'DAILY'
  isActive: boolean
  rows: { salaryComponentId: string; amount: string }[]
  pfEmployeeRate: string
  pfEmployerRate: string
  pfWageCeiling: string
  pfEpsRate: string
  esiEmployeeRate: string
  esiEmployerRate: string
  esiWageLimit: string
}

function emptyStructureForm(): StructureForm {
  return {
    name: '',
    code: '',
    salaryBasis: 'MONTHLY',
    isActive: true,
    rows: [{ salaryComponentId: '', amount: '' }],
    pfEmployeeRate: '12',
    pfEmployerRate: '12',
    pfWageCeiling: '15000',
    pfEpsRate: '8.33',
    esiEmployeeRate: '0.75',
    esiEmployerRate: '3.25',
    esiWageLimit: '21000',
  }
}

function StructuresTab({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<SalaryStructure | null>(null)
  const [creating, setCreating] = useState(false)

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['salary-structures', 'all'],
    queryFn: () => get<SalaryStructure[]>('/salary/structures', { activeOnly: 'false' }),
  })

  const { data: components } = useQuery({
    queryKey: ['salary-components', 'all'],
    queryFn: () => get<SalaryComponent[]>('/salary/components', { activeOnly: 'true' }),
  })

  const [form, setForm] = useState<StructureForm>(emptyStructureForm())

  const openCreate = (): void => {
    setForm(emptyStructureForm())
    setCreating(true)
  }

  const openEdit = (structure: SalaryStructure): void => {
    setForm({
      name: structure.name,
      code: structure.code,
      salaryBasis: structure.salaryBasis,
      isActive: structure.isActive,
      rows: structure.components.map((component) => ({
        salaryComponentId: component.salaryComponentId,
        amount: String(component.amount),
      })),
      pfEmployeeRate: String(structure.pfEmployeeRate),
      pfEmployerRate: String(structure.pfEmployerRate),
      pfWageCeiling: String(structure.pfWageCeiling),
      pfEpsRate: String(structure.pfEpsRate),
      esiEmployeeRate: String(structure.esiEmployeeRate),
      esiEmployerRate: String(structure.esiEmployerRate),
      esiWageLimit: String(structure.esiWageLimit),
    })
    setEditing(structure)
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name,
        code: form.code.toUpperCase(),
        description: null,
        salaryBasis: form.salaryBasis,
        currencyCode: 'INR',
        isActive: form.isActive,
        pfEmployeeRate: Number(form.pfEmployeeRate) || 0,
        pfEmployerRate: Number(form.pfEmployerRate) || 0,
        pfWageCeiling: Number(form.pfWageCeiling) || 0,
        pfEpsRate: Number(form.pfEpsRate) || 0,
        esiEmployeeRate: Number(form.esiEmployeeRate) || 0,
        esiEmployerRate: Number(form.esiEmployerRate) || 0,
        esiWageLimit: Number(form.esiWageLimit) || 0,
        components: form.rows
          .filter((row) => row.salaryComponentId)
          .map((row, index) => ({
            salaryComponentId: row.salaryComponentId,
            calculationType: 'FIXED' as const,
            amount: Number(row.amount) || 0,
            percentage: 0,
            displayOrder: index,
          })),
      }
      return editing ? put(`/salary/structures/${editing.id}`, payload) : post('/salary/structures', payload)
    },
    onSuccess: async () => {
      toast.success('Salary structure saved')
      setCreating(false)
      setEditing(null)
      await queryClient.invalidateQueries({ queryKey: ['salary-structures'] })
    },
    onError: (mutationError: Error) => toast.error('Could not save the structure', mutationError.message),
  })

  const columns: Column<SalaryStructure>[] = [
    {
      key: 'name',
      header: 'Structure',
      render: (row) => (
        <div>
          <strong>{row.name}</strong>
          <p className="subtle">{row.code}</p>
        </div>
      ),
    },
    { key: 'basis', header: 'Basis', render: (row) => <Badge tone="info">{humanise(row.salaryBasis)}</Badge> },
    { key: 'components', header: 'Components', align: 'right', render: (row) => row.components.length },
    {
      key: 'gross',
      header: 'Gross',
      align: 'right',
      render: (row) => (
        <span className="numeric">
          {formatCurrency(row.summary.fixedGross)}
          <span className="subtle">{row.salaryBasis === 'DAILY' ? ' / day' : ' / month'}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            render: (row: SalaryStructure) => (
              <Button size="sm" variant="ghost" onClick={() => openEdit(row)}>
                Edit
              </Button>
            ),
          },
        ]
      : []),
  ]

  const total = form.rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0)

  return (
    <Card
      title="Salary structures"
      description="A structure is a template; the per-employee amount is set when the salary is assigned."
      actions={
        canManage ? (
          <Button size="sm" icon={<Plus size={14} />} onClick={openCreate}>
            Add structure
          </Button>
        ) : null
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
        emptyTitle="No salary structures yet"
        emptyDescription="Create one before assigning salaries."
        caption="Salary structures"
      />

      <Modal
        open={creating || editing !== null}
        title={editing ? `Edit ${editing.name}` : 'Add salary structure'}
        description="Amounts here are the full-period entitlement, before attendance is applied."
        size="lg"
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setCreating(false)
                setEditing(null)
              }}
            >
              Cancel
            </Button>
            <Button
              loading={saveMutation.isPending}
              disabled={!form.name || !form.code || form.rows.filter((row) => row.salaryComponentId).length === 0}
              onClick={() => saveMutation.mutate()}
            >
              Save structure
            </Button>
          </>
        }
      >
        <div className="stack">
          <div className="grid grid-2">
            <Field label="Name" htmlFor="structure-name" required>
              <Input id="structure-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <Field label="Code" htmlFor="structure-code" required>
              <Input
                id="structure-code"
                value={form.code}
                disabled={Boolean(editing)}
                style={{ textTransform: 'uppercase' }}
                onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })}
              />
            </Field>
            <Field
              label="Salary basis"
              htmlFor="structure-basis"
              hint="Daily structures hold per-day amounts multiplied by paid days."
            >
              <Select
                id="structure-basis"
                value={form.salaryBasis}
                disabled={Boolean(editing)}
                onChange={(event) => setForm({ ...form, salaryBasis: event.target.value as 'MONTHLY' | 'DAILY' })}
              >
                <option value="MONTHLY">Monthly</option>
                <option value="DAILY">Daily</option>
              </Select>
            </Field>
          </div>

          <div>
            <p className="field-label">Components</p>
            <div className="stack" style={{ gap: '0.5rem', marginTop: '0.4rem' }}>
              {form.rows.map((row, index) => (
                <div key={index} className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <Select
                    value={row.salaryComponentId}
                    aria-label={`Component ${index + 1}`}
                    onChange={(event) => {
                      const rows = [...form.rows]
                      rows[index] = { ...(rows[index] as { salaryComponentId: string; amount: string }), salaryComponentId: event.target.value }
                      setForm({ ...form, rows })
                    }}
                  >
                    <option value="">Select a component</option>
                    {(components ?? []).map((component) => (
                      <option key={component.id} value={component.id}>
                        {component.name}
                      </option>
                    ))}
                  </Select>

                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    style={{ maxWidth: 160 }}
                    placeholder="Amount"
                    aria-label={`Amount for component ${index + 1}`}
                    value={row.amount}
                    onChange={(event) => {
                      const rows = [...form.rows]
                      rows[index] = { ...(rows[index] as { salaryComponentId: string; amount: string }), amount: event.target.value }
                      setForm({ ...form, rows })
                    }}
                  />

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setForm({ ...form, rows: form.rows.filter((_, position) => position !== index) })}
                  >
                    Remove
                  </Button>
                </div>
              ))}

              <Button
                variant="secondary"
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => setForm({ ...form, rows: [...form.rows, { salaryComponentId: '', amount: '' }] })}
              >
                Add component
              </Button>
            </div>
          </div>

          <div className="breakdown-total">
            <span>Total</span>
            <span className="numeric">
              {formatCurrency(total)}
              {form.salaryBasis === 'DAILY' ? ' per day' : ' per month'}
            </span>
          </div>

          <div>
            <p className="field-label">PF and ESI rates</p>
            <p className="subtle" style={{ marginTop: '0.2rem' }}>
              PF has no wage ceiling and always applies. ESI applies, on both sides, only when this structure's gross is
              Rs 21,000 or below.
            </p>
            <div className="grid grid-2" style={{ marginTop: '0.4rem' }}>
              <Field label="PF - employee %" htmlFor="pf-employee-rate">
                <Input
                  id="pf-employee-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={form.pfEmployeeRate}
                  onChange={(event) => setForm({ ...form, pfEmployeeRate: event.target.value })}
                />
              </Field>
              <Field label="PF - employer %" htmlFor="pf-employer-rate">
                <Input
                  id="pf-employer-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={form.pfEmployerRate}
                  onChange={(event) => setForm({ ...form, pfEmployerRate: event.target.value })}
                />
              </Field>
              <Field label="ESI - employee %" htmlFor="esi-employee-rate">
                <Input
                  id="esi-employee-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={form.esiEmployeeRate}
                  onChange={(event) => setForm({ ...form, esiEmployeeRate: event.target.value })}
                />
              </Field>
              <Field label="ESI - employer %" htmlFor="esi-employer-rate">
                <Input
                  id="esi-employer-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={form.esiEmployerRate}
                  onChange={(event) => setForm({ ...form, esiEmployerRate: event.target.value })}
                />
              </Field>
            </div>
          </div>
        </div>
      </Modal>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const emptyComponentForm = { name: '', code: '', isActive: true }

function ComponentsTab({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<SalaryComponent | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SalaryComponent | null>(null)
  const [form, setForm] = useState(emptyComponentForm)

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['salary-components', 'all'],
    queryFn: () => get<SalaryComponent[]>('/salary/components', { activeOnly: 'false' }),
  })

  const closeModal = () => {
    setModalOpen(false)
    setEditing(null)
    setForm(emptyComponentForm)
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name,
        code: form.code.toUpperCase(),
        isActive: form.isActive,
      }
      return editing ? put(`/salary/components/${editing.id}`, payload) : post('/salary/components', payload)
    },
    onSuccess: async () => {
      toast.success(editing ? 'Component updated' : 'Component created')
      closeModal()
      await queryClient.invalidateQueries({ queryKey: ['salary-components'] })
    },
    onError: (mutationError: Error) =>
      toast.error(editing ? 'Could not update the component' : 'Could not create the component', mutationError.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (component: SalaryComponent) => del(`/salary/components/${component.id}`),
    onSuccess: async () => {
      toast.success('Component deleted')
      setDeleteTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['salary-components'] })
    },
    onError: (mutationError: Error) => {
      setDeleteTarget(null)
      toast.error('Could not delete the component', mutationError.message)
    },
  })

  const openEdit = (component: SalaryComponent) => {
    setEditing(component)
    setForm({
      name: component.name,
      code: component.code,
      isActive: component.isActive,
    })
    setModalOpen(true)
  }

  const columns: Column<SalaryComponent>[] = [
    {
      key: 'name',
      header: 'Component',
      render: (row) => (
        <div>
          <strong>{row.name}</strong>
          <p className="subtle">{row.code}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            render: (row: SalaryComponent) => (
              <div className="row" style={{ gap: '0.4rem', justifyContent: 'flex-end' }}>
                <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => openEdit(row)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDeleteTarget(row)}>
                  Delete
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ]

  return (
    <Card
      title="Salary components"
      description="A component is a fixed, prorated earning, such as Basic or HRA. Every component counts toward a structure's PF and ESI wage; the PF, ESI & policy tab sets the ceiling and limit that cap it."
      actions={
        canManage ? (
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setModalOpen(true)}>
            Add component
          </Button>
        ) : null
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
        emptyTitle="No components yet"
        caption="Salary components"
      />

      <Modal
        open={modalOpen}
        title={editing ? 'Edit salary component' : 'Add salary component'}
        onClose={closeModal}
        footer={
          <>
            <Button variant="secondary" onClick={closeModal}>
              Cancel
            </Button>
            <Button loading={saveMutation.isPending} disabled={!form.name || !form.code} onClick={() => saveMutation.mutate()}>
              {editing ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="stack">
          <div className="grid grid-2">
            <Field label="Name" htmlFor="component-name" required>
              <Input id="component-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <Field label="Code" htmlFor="component-code" required>
              <Input
                id="component-code"
                value={form.code}
                style={{ textTransform: 'uppercase' }}
                onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })}
              />
            </Field>
          </div>

          {editing ? (
            <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
              <span>Active</span>
            </label>
          ) : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete salary component"
        message={`Delete "${deleteTarget?.name}"? This only works if it is not used by any salary structure - otherwise, deactivate it instead.`}
        confirmLabel="Delete"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Assigning a salary
// ---------------------------------------------------------------------------

function AssignTab() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data: structures } = useSalaryStructures()

  const [employeeId, setEmployeeId] = useState('')
  const [form, setForm] = useState({ salaryStructureId: '', effectiveFrom: '', overrideAmount: '', notes: '' })

  const { data: history, refetch } = useQuery({
    queryKey: ['employee', employeeId, 'salary'],
    queryFn: () => get<{ assignments: { id: string; effectiveFrom: string; effectiveTo: string | null; structureName: string | null; overrideAmount: number | null; notes: string | null }[] }>(
      `/employees/${employeeId}/salary`,
    ),
    enabled: Boolean(employeeId),
  })

  const mutation = useMutation({
    mutationFn: () =>
      post(`/employees/${employeeId}/salary`, {
        salaryStructureId: form.salaryStructureId,
        effectiveFrom: form.effectiveFrom,
        overrideAmount: form.overrideAmount ? Number(form.overrideAmount) : null,
        notes: form.notes || null,
      }),
    onSuccess: async () => {
      toast.success('Salary assigned', 'The previous assignment has been closed, not overwritten.')
      setForm({ salaryStructureId: '', effectiveFrom: '', overrideAmount: '', notes: '' })
      await queryClient.invalidateQueries({ queryKey: ['employee', employeeId] })
      await refetch()
    },
    onError: (mutationError: Error) => toast.error('Could not assign the salary', mutationError.message),
  })

  const selectedStructure = structures?.find((structure) => structure.id === form.salaryStructureId)

  return (
    <div className="grid grid-2">
      <Card title="Assign a salary" description="Historical assignments are preserved so old payroll stays reproducible.">
        <div className="stack">
          <Field label="Employee" htmlFor="assign-employee" required>
            <EmployeeSelector id="assign-employee" value={employeeId} onChange={setEmployeeId} />
          </Field>

          <Field label="Salary structure" htmlFor="assign-structure" required>
            <Select
              id="assign-structure"
              value={form.salaryStructureId}
              onChange={(event) => setForm({ ...form, salaryStructureId: event.target.value })}
            >
              <option value="">Select a structure</option>
              {(structures ?? []).map((structure) => (
                <option key={structure.id} value={structure.id}>
                  {structure.name} ({humanise(structure.salaryBasis)})
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Effective from" htmlFor="assign-from" required hint="The previous assignment is closed the day before this date.">
            <Input
              id="assign-from"
              type="date"
              value={form.effectiveFrom}
              onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })}
            />
          </Field>

          <Field
            label={selectedStructure?.salaryBasis === 'DAILY' ? 'Daily rate' : 'Monthly gross'}
            htmlFor="assign-amount"
            hint={
              selectedStructure
                ? `Leave blank to use the structure total of ${formatCurrency(selectedStructure.summary.fixedGross)}. Components scale proportionally.`
                : 'Leave blank to use the structure total.'
            }
          >
            <Input
              id="assign-amount"
              type="number"
              step="0.01"
              min="0"
              value={form.overrideAmount}
              onChange={(event) => setForm({ ...form, overrideAmount: event.target.value })}
            />
          </Field>

          <Field label="Notes" htmlFor="assign-notes">
            <Input id="assign-notes" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </Field>

          <Button
            loading={mutation.isPending}
            disabled={!employeeId || !form.salaryStructureId || !form.effectiveFrom}
            onClick={() => mutation.mutate()}
          >
            Assign salary
          </Button>
        </div>
      </Card>

      <Card title="Salary history" description={employeeId ? undefined : 'Select an employee to see their history.'}>
        {history && history.assignments.length > 0 ? (
          <div className="breakdown-list">
            {history.assignments.map((assignment) => (
              <div key={assignment.id} className="breakdown-row">
                <span>
                  {formatDate(assignment.effectiveFrom)} → {assignment.effectiveTo ? formatDate(assignment.effectiveTo) : 'current'}
                  <p className="subtle">{assignment.structureName}</p>
                </span>
                <span className="numeric">
                  {assignment.overrideAmount === null ? 'Structure default' : formatCurrency(assignment.overrideAmount)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">{employeeId ? 'No salary assigned yet.' : 'No employee selected.'}</p>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PF, ESI & policy
// ---------------------------------------------------------------------------

interface RateForm {
  structure: SalaryStructure
  pfEmployeeRate: string
  pfEmployerRate: string
  pfWageCeiling: string
  pfEpsRate: string
  esiEmployeeRate: string
  esiEmployerRate: string
  esiWageLimit: string
}

/**
 * PF is deducted, on both sides, on the wage up to the PF wage ceiling; ESI
 * applies, on both sides, only when the structure's gross is at or below the
 * ESI wage limit. Both the ceiling/limit and the rates are configured here,
 * per structure.
 */
function PfEsiTab() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [rateForm, setRateForm] = useState<RateForm | null>(null)

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['salary-structures', 'all'],
    queryFn: () => get<SalaryStructure[]>('/salary/structures', { activeOnly: 'false' }),
  })

  const saveMutation = useMutation({
    mutationFn: (values: RateForm) =>
      put(`/salary/structures/${values.structure.id}`, {
        name: values.structure.name,
        code: values.structure.code,
        description: values.structure.description,
        salaryBasis: values.structure.salaryBasis,
        currencyCode: values.structure.currencyCode,
        isActive: values.structure.isActive,
        pfEmployeeRate: Number(values.pfEmployeeRate) || 0,
        pfEmployerRate: Number(values.pfEmployerRate) || 0,
        pfWageCeiling: Number(values.pfWageCeiling) || 0,
        pfEpsRate: Number(values.pfEpsRate) || 0,
        esiEmployeeRate: Number(values.esiEmployeeRate) || 0,
        esiEmployerRate: Number(values.esiEmployerRate) || 0,
        esiWageLimit: Number(values.esiWageLimit) || 0,
        components: values.structure.components.map((component, index) => ({
          salaryComponentId: component.salaryComponentId,
          calculationType: component.calculationType,
          amount: component.amount,
          percentage: component.percentage,
          displayOrder: component.displayOrder ?? index,
        })),
      }),
    onSuccess: async () => {
      toast.success('PF and ESI settings saved')
      setRateForm(null)
      await queryClient.invalidateQueries({ queryKey: ['salary-structures'] })
    },
    onError: (mutationError: Error) => toast.error('Could not save the settings', mutationError.message),
  })

  const columns: Column<SalaryStructure>[] = [
    {
      key: 'name',
      header: 'Structure',
      render: (row) => (
        <div>
          <strong>{row.name}</strong>
          <p className="subtle">{row.code}</p>
        </div>
      ),
    },
    {
      key: 'pf',
      header: 'PF (employee / employer)',
      align: 'right',
      render: (row) => (
        <span className="numeric">
          {row.pfEmployeeRate}% / {row.pfEmployerRate}%
          <p className="subtle">Ceiling {formatCurrency(row.pfWageCeiling)}</p>
        </span>
      ),
    },
    {
      key: 'esi',
      header: 'ESI (employee / employer)',
      align: 'right',
      render: (row) => (
        <span className="numeric">
          {row.esiEmployeeRate}% / {row.esiEmployerRate}%
          <p className="subtle">Limit {formatCurrency(row.esiWageLimit)}</p>
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setRateForm({
              structure: row,
              pfEmployeeRate: String(row.pfEmployeeRate),
              pfEmployerRate: String(row.pfEmployerRate),
              pfWageCeiling: String(row.pfWageCeiling),
              pfEpsRate: String(row.pfEpsRate),
              esiEmployeeRate: String(row.esiEmployeeRate),
              esiEmployerRate: String(row.esiEmployerRate),
              esiWageLimit: String(row.esiWageLimit),
            })
          }
        >
          Edit
        </Button>
      ),
    },
  ]

  return (
    <Card
      title="PF, ESI & policy"
      description="PF is deducted, on both sides, on the wage up to the PF wage ceiling. ESI applies, on both sides, only when a structure's gross is at or below the ESI wage limit. Set each structure's rates, ceiling and limit here."
      padded={false}
    >
      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(row) => row.id}
        loading={isFetching}
        error={error}
        onRetry={() => void refetch()}
        emptyTitle="No salary structures yet"
        emptyDescription="Create a structure in the Structures tab first."
        caption="PF and ESI rates by structure"
      />

      <Modal
        open={rateForm !== null}
        title={rateForm ? `PF and ESI — ${rateForm.structure.name}` : ''}
        onClose={() => setRateForm(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRateForm(null)}>
              Cancel
            </Button>
            <Button loading={saveMutation.isPending} onClick={() => rateForm && saveMutation.mutate(rateForm)}>
              Save
            </Button>
          </>
        }
      >
        {rateForm ? (
          <div className="stack">
            <div className="grid grid-2">
              <Field label="PF - employee %" htmlFor="rate-pf-employee">
                <Input
                  id="rate-pf-employee"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={rateForm.pfEmployeeRate}
                  onChange={(event) => setRateForm({ ...rateForm, pfEmployeeRate: event.target.value })}
                />
              </Field>
              <Field label="PF - employer %" htmlFor="rate-pf-employer">
                <Input
                  id="rate-pf-employer"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={rateForm.pfEmployerRate}
                  onChange={(event) => setRateForm({ ...rateForm, pfEmployerRate: event.target.value })}
                />
              </Field>
              <Field
                label="PF wage ceiling"
                htmlFor="rate-pf-ceiling"
                hint="Both sides are calculated on the wage up to this amount. 0 means no ceiling."
              >
                <Input
                  id="rate-pf-ceiling"
                  type="number"
                  step="0.01"
                  min="0"
                  value={rateForm.pfWageCeiling}
                  onChange={(event) => setRateForm({ ...rateForm, pfWageCeiling: event.target.value })}
                />
              </Field>
              <Field
                label="PF employer - EPS share %"
                htmlFor="rate-pf-eps"
                hint="Out of the employer %, how much goes to the Pension Scheme (EPS); the rest goes to EPF."
              >
                <Input
                  id="rate-pf-eps"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={rateForm.pfEpsRate}
                  onChange={(event) => setRateForm({ ...rateForm, pfEpsRate: event.target.value })}
                />
              </Field>
              <Field label="ESI - employee %" htmlFor="rate-esi-employee">
                <Input
                  id="rate-esi-employee"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={rateForm.esiEmployeeRate}
                  onChange={(event) => setRateForm({ ...rateForm, esiEmployeeRate: event.target.value })}
                />
              </Field>
              <Field label="ESI - employer %" htmlFor="rate-esi-employer">
                <Input
                  id="rate-esi-employer"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={rateForm.esiEmployerRate}
                  onChange={(event) => setRateForm({ ...rateForm, esiEmployerRate: event.target.value })}
                />
              </Field>
              <Field
                label="ESI wage limit"
                htmlFor="rate-esi-limit"
                hint="ESI applies, on the full wage, only when the structure's gross is at or below this amount. 0 means always applies."
              >
                <Input
                  id="rate-esi-limit"
                  type="number"
                  step="0.01"
                  min="0"
                  value={rateForm.esiWageLimit}
                  onChange={(event) => setRateForm({ ...rateForm, esiWageLimit: event.target.value })}
                />
              </Field>
            </div>
          </div>
        ) : null}
      </Modal>
    </Card>
  )
}
