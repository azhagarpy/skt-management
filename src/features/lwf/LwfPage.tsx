import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Play, Trash2 } from 'lucide-react'
import { del, download, get, post, request } from '../../lib/api'
import { MONTH_NAMES, formatCurrency, formatDate, todayIso } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Badge, Button, Card, ConfirmDialog, Field, Input, Modal, PageHeader, Select, StatTile } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import { EmployeeSelector } from '../../components/forms/selectors'
import type { LwfContribution } from '../../types/api'

/**
 * Labour Welfare Fund: a small yearly statutory contribution - a fixed amount
 * from the employee (deducted through payroll, like P.Tax) plus a matching
 * amount from the employer that is only tracked here, never deducted. Once the
 * organization has actually remitted it to the government, an admin marks it
 * paid with a reference number and an optional proof document.
 */

export default function LwfPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const canManage = can('lwf.manage')

  const now = new Date()
  const [contributionYear, setContributionYear] = useState(now.getFullYear())
  const [status, setStatus] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [markPaidTarget, setMarkPaidTarget] = useState<LwfContribution | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LwfContribution | null>(null)

  const filters = {
    contributionYear,
    status: status || undefined,
    employeeId: employeeId || undefined,
  }

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['lwf', filters],
    queryFn: () => get<LwfContribution[]>('/lwf', filters),
  })

  const deleteMutation = useMutation({
    mutationFn: (row: LwfContribution) => del(`/lwf/${row.id}`),
    onSuccess: async () => {
      toast.success('Row removed')
      setDeleteTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['lwf'] })
    },
    onError: (mutationError: Error) => {
      setDeleteTarget(null)
      toast.error('Could not remove the row', mutationError.message)
    },
  })

  const rows = data ?? []
  const years = Array.from({ length: 5 }, (_, index) => now.getFullYear() + 1 - index)
  const totals = rows.reduce(
    (sum, row) => ({ employee: sum.employee + row.employeeAmount, employer: sum.employer + row.employerAmount }),
    { employee: 0, employer: 0 },
  )
  const pendingCount = rows.filter((row) => row.status === 'PENDING').length

  const downloadProof = async (row: LwfContribution): Promise<void> => {
    try {
      await download(`/lwf/${row.id}/proof`, row.proofFilename ?? `lwf-${row.employeeCode}-${row.contributionYear}`)
    } catch (downloadError) {
      toast.error('Could not download the reference document', downloadError instanceof Error ? downloadError.message : undefined)
    }
  }

  const columns: Column<LwfContribution>[] = [
    {
      key: 'employee',
      header: 'Employee',
      render: (row) => (
        <div>
          <strong>{row.employeeName ?? '—'}</strong>
          <p className="subtle">{row.employeeCode}</p>
        </div>
      ),
    },
    { key: 'department', header: 'Department', hideOnMobile: true, render: (row) => row.departmentName ?? '—' },
    { key: 'employeeAmount', header: 'Employee', align: 'right', render: (row) => formatCurrency(row.employeeAmount) },
    { key: 'employerAmount', header: 'Employer', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.employerAmount) },
    { key: 'total', header: 'Total', align: 'right', render: (row) => <strong>{formatCurrency(row.totalAmount)}</strong> },
    {
      key: 'period',
      header: 'Deducted in',
      render: (row) => `${MONTH_NAMES[row.payrollMonth - 1]} ${row.payrollYear}`,
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.status === 'PAID' ? (
          <div>
            <Badge tone="success">Paid</Badge>
            <p className="subtle">
              {formatDate(row.paidOn)} · {row.referenceNumber}
            </p>
          </div>
        ) : (
          <Badge tone="neutral">Pending</Badge>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right' as const,
      render: (row) => (
        <div className="row" style={{ gap: '0.35rem', justifyContent: 'flex-end' }}>
          {row.hasProof ? (
            <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => void downloadProof(row)}>
              Proof
            </Button>
          ) : null}
          {canManage && row.status === 'PENDING' ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => setMarkPaidTarget(row)}>
                Mark paid
              </Button>
              <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDeleteTarget(row)}>
                Remove
              </Button>
            </>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="Labour Welfare Fund"
        description="A yearly contribution: a fixed amount from the employee, deducted through payroll, plus a matching amount from the employer that is tracked here only."
      />

      {canManage ? <GenerateCard years={years} /> : null}

      <div className="grid grid-4">
        <StatTile label="Rows" value={rows.length} tone="info" />
        <StatTile label="Employee share" value={formatCurrency(totals.employee)} tone="accent" />
        <StatTile label="Employer share" value={formatCurrency(totals.employer)} tone="accent" />
        <StatTile label="Pending" value={pendingCount} tone="warning" />
      </div>

      <Card padded={false}>
        <div className="filter-bar">
          <Field label="Contribution year" htmlFor="lwf-year">
            <Select id="lwf-year" value={contributionYear} onChange={(event) => setContributionYear(Number(event.target.value))}>
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status" htmlFor="lwf-status">
            <Select id="lwf-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="PAID">Paid</option>
            </Select>
          </Field>
          <Field label="Employee" htmlFor="lwf-employee-filter">
            <EmployeeSelector id="lwf-employee-filter" value={employeeId} onChange={setEmployeeId} />
          </Field>
        </div>

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          emptyTitle="No Labour Welfare Fund rows for this year"
          caption="Labour Welfare Fund"
        />
      </Card>

      <MarkPaidModal target={markPaidTarget} onClose={() => setMarkPaidTarget(null)} />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove row"
        message={`Remove the Labour Welfare Fund row for ${deleteTarget?.employeeName}?`}
        confirmLabel="Remove"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

function GenerateCard({ years }: { years: number[] }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const now = new Date()

  const [form, setForm] = useState({
    contributionYear: now.getFullYear(),
    payrollYear: now.getFullYear(),
    payrollMonth: now.getMonth() + 1,
    employeeAmount: '20',
    employerAmount: '40',
  })

  const generateMutation = useMutation({
    mutationFn: () =>
      post('/lwf/generate', {
        contributionYear: form.contributionYear,
        payrollYear: form.payrollYear,
        payrollMonth: form.payrollMonth,
        employeeAmount: Number(form.employeeAmount),
        employerAmount: Number(form.employerAmount),
      }),
    onSuccess: async (response) => {
      toast.success(response.message ?? 'Generated')
      await queryClient.invalidateQueries({ queryKey: ['lwf'] })
    },
    onError: (mutationError: Error) => toast.error('Could not generate', mutationError.message),
  })

  return (
    <Card
      title="Generate for a year"
      description="Adds one row for every active employee who doesn't already have one for that year. Existing rows (including anything already paid) are left untouched."
    >
      <div className="stack">
        <div className="grid grid-3">
          <Field label="Contribution year" htmlFor="lwf-gen-year" required>
            <Select
              id="lwf-gen-year"
              value={form.contributionYear}
              onChange={(event) => setForm({ ...form, contributionYear: Number(event.target.value) })}
            >
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Employee amount" htmlFor="lwf-gen-employee-amount" required>
            <Input
              id="lwf-gen-employee-amount"
              type="number"
              step="0.01"
              min="0"
              value={form.employeeAmount}
              onChange={(event) => setForm({ ...form, employeeAmount: event.target.value })}
            />
          </Field>
          <Field label="Employer amount" htmlFor="lwf-gen-employer-amount" required>
            <Input
              id="lwf-gen-employer-amount"
              type="number"
              step="0.01"
              min="0"
              value={form.employerAmount}
              onChange={(event) => setForm({ ...form, employerAmount: event.target.value })}
            />
          </Field>
        </div>
        <div className="grid grid-2">
          <Field label="Deduct in payroll month" htmlFor="lwf-gen-month" required>
            <Select
              id="lwf-gen-month"
              value={form.payrollMonth}
              onChange={(event) => setForm({ ...form, payrollMonth: Number(event.target.value) })}
            >
              {MONTH_NAMES.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payroll year" htmlFor="lwf-gen-payroll-year" required>
            <Select
              id="lwf-gen-payroll-year"
              value={form.payrollYear}
              onChange={(event) => setForm({ ...form, payrollYear: Number(event.target.value) })}
            >
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div>
          <Button icon={<Play size={15} />} loading={generateMutation.isPending} onClick={() => generateMutation.mutate()}>
            Generate
          </Button>
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Mark paid
// ---------------------------------------------------------------------------

function MarkPaidModal({ target, onClose }: { target: LwfContribution | null; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [paidOn, setPaidOn] = useState(todayIso())
  const [referenceNumber, setReferenceNumber] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const close = (): void => {
    setPaidOn(todayIso())
    setReferenceNumber('')
    setFile(null)
    onClose()
  }

  const markPaidMutation = useMutation({
    mutationFn: () => {
      const formData = new FormData()
      formData.append('paidOn', paidOn)
      formData.append('referenceNumber', referenceNumber.trim())
      if (file) formData.append('file', file)
      return request(`/lwf/${target?.id}/mark-paid`, { method: 'PATCH', formData })
    },
    onSuccess: async () => {
      toast.success('Marked as paid')
      await queryClient.invalidateQueries({ queryKey: ['lwf'] })
      close()
    },
    onError: (mutationError: Error) => toast.error('Could not mark as paid', mutationError.message),
  })

  const canSubmit = Boolean(paidOn) && referenceNumber.trim().length > 0

  return (
    <Modal
      open={target !== null}
      title="Mark as paid"
      description={target ? `Record that the Labour Welfare Fund for ${target.employeeName} (${target.contributionYear}) has been remitted.` : undefined}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button loading={markPaidMutation.isPending} disabled={!canSubmit} onClick={() => markPaidMutation.mutate()}>
            Mark as paid
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Paid on" htmlFor="lwf-paid-on" required>
            <Input id="lwf-paid-on" type="date" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} />
          </Field>
          <Field label="Reference number" htmlFor="lwf-reference" required>
            <Input id="lwf-reference" value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} />
          </Field>
        </div>
        <Field label="Reference document" htmlFor="lwf-proof-file" hint="Optional. PDF, PNG or JPEG.">
          <input
            id="lwf-proof-file"
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
      </div>
    </Modal>
  )
}
