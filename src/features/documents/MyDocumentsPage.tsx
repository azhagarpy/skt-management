import { useQuery } from '@tanstack/react-query'
import { get } from '../../lib/api'
import { useAuth } from '../../app/providers/AuthProvider'
import { Badge, Card, ErrorState, PageHeader, ProgressBar, Spinner, StatusBadge } from '../../components/ui'
import { IdentitySection } from '../employees/IdentitySection'
import type { EmployeeDetail } from '../../types/api'

/**
 * An employee's own documents and identity details.
 *
 * The completion checklist is the same one payroll relies on, so an employee can
 * see exactly what is still missing (plan sections 12 and 45).
 */
export default function MyDocumentsPage() {
  const { user } = useAuth()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['employee', 'me'],
    queryFn: () => get<EmployeeDetail>('/employees/me'),
  })

  if (isLoading) return <Spinner label="Loading your documents" />
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />
  if (!data) return null

  const completion = data.profileCompletion

  return (
    <div className="page">
      <PageHeader
        title="My documents"
        description="Upload and keep your identity and financial details current. Payroll needs these to pay you correctly."
      />

      <Card title="Profile completion">
        <div className="stack">
          <ProgressBar value={completion.completionPercent} tone={completion.isComplete ? 'success' : 'warning'} />
          <p className="subtle">
            {completion.completedSections} of {completion.totalSections} sections complete ·{' '}
            {completion.completionPercent}%
          </p>

          <div className="stack" style={{ gap: '0.3rem' }}>
            {completion.sections.map((section) => (
              <div key={section.section} className="breakdown-row">
                <span>{section.label}</span>
                <span>
                  {section.complete ? (
                    <StatusBadge status={section.verificationStatus ?? 'VERIFIED'} />
                  ) : (
                    <Badge tone="warning">Not provided</Badge>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <IdentitySection employeeId={user?.employeeId ?? data.id} editable />
    </div>
  )
}
