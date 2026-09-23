import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { get } from '../../lib/api'
import { formatCurrency, formatDate, formatDays, humanise } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { Card, ErrorState, PageHeader, Spinner, StatTile, StatusBadge } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import type { PayrollItem, SalaryHistory } from '../../types/api'

/**
 * An employee's own salary: their current structure, and the payroll months that
 * have been approved. Unapproved runs are never visible here.
 */
export default function MySalaryPage() {
  const { can } = useAuth()

  const salaryQuery = useQuery({
    queryKey: ['employee', 'me', 'salary'],
    queryFn: () => get<SalaryHistory>('/employees/me/salary'),
    enabled: can('salary.view.self'),
  })

  const payrollQuery = useQuery({
    queryKey: ['payroll', 'my-payroll'],
    queryFn: () => get<PayrollItem[]>('/payroll/my-payroll', { employeeId: 'me', limit: 24 }),
    enabled: can('payroll.view.self'),
  })

  const columns: Column<PayrollItem>[] = [
    {
      key: 'period',
      header: 'Month',
      render: (row) => (
        <Link to={`/payroll/items/${row.id}`}>
          <strong>
            {row.runMonth}/{row.runYear}
          </strong>
        </Link>
      ),
    },
    { key: 'days', header: 'Paid days', align: 'right', render: (row) => formatDays(row.attendance.paidDays) },
    { key: 'gross', header: 'Gross', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.grossEarnings) },
    { key: 'deductions', header: 'Deductions', align: 'right', hideOnMobile: true, render: (row) => formatCurrency(row.totalDeductions) },
    { key: 'net', header: 'Net', align: 'right', render: (row) => <strong>{formatCurrency(row.netSalary)}</strong> },
    { key: 'paid', header: 'Paid', align: 'right', render: (row) => formatCurrency(row.paidAmount) },
    { key: 'status', header: 'Payment', render: (row) => <StatusBadge status={row.paymentStatus} /> },
  ]

  const current = salaryQuery.data?.current
  const structure = salaryQuery.data?.currentStructure
  const latest = payrollQuery.data?.[0]

  return (
    <div className="page">
      <PageHeader title="My salary" description="Your salary structure and the payroll months that have been published." />

      {salaryQuery.isLoading || payrollQuery.isLoading ? <Spinner label="Loading your salary" /> : null}
      {salaryQuery.error ? <ErrorState error={salaryQuery.error} onRetry={() => void salaryQuery.refetch()} /> : null}

      <div className="grid grid-4">
        <StatTile
          label={current?.salaryBasis === 'DAILY' ? 'Daily rate' : 'Monthly gross'}
          value={
            current
              ? formatCurrency(current.overrideAmount ?? structure?.summary.fixedGross ?? null)
              : '—'
          }
          sublabel={current ? `Effective ${formatDate(current.effectiveFrom)}` : 'No salary assigned yet'}
          tone="accent"
        />
        <StatTile
          label="Latest net"
          value={latest ? formatCurrency(latest.netSalary) : '—'}
          sublabel={latest ? `${latest.runMonth}/${latest.runYear}` : undefined}
          tone="success"
        />
        <StatTile label="Paid" value={latest ? formatCurrency(latest.paidAmount) : '—'} tone="info" />
        <StatTile
          label="Pending"
          value={latest ? formatCurrency(latest.pendingAmount) : '—'}
          sublabel={latest ? humanise(latest.paymentStatus) : undefined}
          tone={latest && latest.pendingAmount > 0 ? 'warning' : 'neutral'}
        />
      </div>

      {structure ? (
        <Card title="My salary structure" description={structure.name}>
          <div className="breakdown-list">
            {structure.components.map((component) => (
              <div key={component.id} className="breakdown-row">
                <span>
                  {component.name}
                  <span className="subtle"> · {humanise(component.componentType)}</span>
                </span>
                <span className="numeric">
                  {component.calculationType === 'PERCENTAGE' ? `${component.percentage}%` : formatCurrency(component.amount)}
                </span>
              </div>
            ))}
          </div>
          <div className="breakdown-total">
            <span>{current?.salaryBasis === 'DAILY' ? 'Daily gross' : 'Monthly gross'}</span>
            <span className="numeric">
              {formatCurrency(current?.overrideAmount ?? structure.summary.fixedGross)}
            </span>
          </div>
          <p className="subtle" style={{ marginTop: '0.75rem' }}>
            What you are actually paid each month depends on your attendance for that month.
          </p>
        </Card>
      ) : null}

      <Card title="Payroll history" padded={false}>
        <DataTable
          columns={columns}
          rows={payrollQuery.data ?? []}
          rowKey={(row) => row.id}
          loading={payrollQuery.isFetching}
          error={payrollQuery.error}
          onRetry={() => void payrollQuery.refetch()}
          emptyTitle="No payroll published yet"
          emptyDescription="Your payroll will appear here once the month has been approved."
          caption="My payroll history"
        />
      </Card>
    </div>
  )
}
