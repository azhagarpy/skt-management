import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { download, get } from '../../lib/api'
import { formatCurrency, formatDateTime, formatFileSize } from '../../lib/format'
import { Button, Card, PageHeader, StatusBadge } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import type { Payslip } from '../../types/api'

/**
 * An employee's payslips.
 *
 * Files are fetched with the session token and handed over as a download; there
 * is no public link to a payslip (plan section 39).
 */
export default function MyPayslipsPage() {
  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['payslips', 'me'],
    queryFn: () => get<Payslip[]>('/payslips', { employeeId: 'me' }),
  })

  const columns: Column<Payslip>[] = [
    { key: 'month', header: 'Month', render: (row) => <strong>{row.monthLabel}</strong> },
    { key: 'net', header: 'Net salary', align: 'right', render: (row) => formatCurrency(row.netSalary) },
    { key: 'status', header: 'Payment', render: (row) => <StatusBadge status={row.paymentStatus} /> },
    { key: 'size', header: 'Size', hideOnMobile: true, render: (row) => formatFileSize(row.fileSizeBytes) },
    { key: 'generated', header: 'Generated', hideOnMobile: true, render: (row) => formatDateTime(row.generatedAt) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <Button
          size="sm"
          variant="secondary"
          icon={<Download size={14} />}
          onClick={() =>
            void download(`/payslips/${row.id}/file`, `payslip-${row.year}-${String(row.month).padStart(2, '0')}.pdf`)
          }
        >
          Download
        </Button>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader title="My payslips" description="Download a PDF payslip for any published month." />

      <Card padded={false}>
        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          emptyTitle="No payslips yet"
          emptyDescription="Payslips appear here once payroll has been approved and they have been generated."
          caption="My payslips"
        />
      </Card>
    </div>
  )
}
