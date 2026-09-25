import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ImageUp, Pencil, Trash2 } from 'lucide-react'
import { del, fetchBlob, get, upload } from '../../lib/api'
import { formatCurrency, formatDate, humanise } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import {
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  PageHeader,
  ProgressBar,
  Spinner,
  StatusBadge,
  Tabs,
} from '../../components/ui'
import { IdentitySection } from './IdentitySection'
import type { EmployeeDetail, SalaryHistory } from '../../types/api'

const PHOTO_TYPES = ['image/png', 'image/jpeg']
const PHOTO_MAX_BYTES = 2 * 1024 * 1024

/**
 * The employee profile.
 *
 * Tabs mirror the sections the plan calls for: personal information, employment,
 * identity and financial documents, and salary history. Each tab only renders
 * what the viewer is allowed to see.
 */
export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { can, user } = useAuth()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState('overview')
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [removingPhoto, setRemovingPhoto] = useState(false)

  const employeeId = id ?? 'me'

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['employee', employeeId],
    queryFn: () => get<EmployeeDetail>(`/employees/${employeeId}`),
    enabled: Boolean(employeeId),
  })

  const canSeeSalary = can('salary.view.all') || can('salary.view.team') || (data?.id === user?.employeeId && can('salary.view.self'))

  const { data: salary } = useQuery({
    queryKey: ['employee', employeeId, 'salary'],
    queryFn: () => get<SalaryHistory>(`/employees/${employeeId}/salary`),
    enabled: Boolean(employeeId) && tab === 'salary' && canSeeSalary,
  })

  // The photo needs the bearer token, so it cannot be an <img src>. Keyed on
  // photoUpdatedAt so replacing it refetches instead of serving a stale one.
  const { data: photoBlob } = useQuery({
    queryKey: ['employee', employeeId, 'photo', data?.photoUpdatedAt],
    queryFn: () => fetchBlob(`/employees/${employeeId}/photo`),
    enabled: Boolean(employeeId) && data?.hasPhoto === true,
    staleTime: Infinity,
  })

  const [photoUrl, setPhotoUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!photoBlob) {
      setPhotoUrl(null)
      return
    }
    const url = URL.createObjectURL(photoBlob)
    setPhotoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [photoBlob])

  const refreshEmployee = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['employee', employeeId] })
  }

  const photoMutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return upload(`/employees/${employeeId}/photo`, formData)
    },
    onSuccess: async () => {
      toast.success('Photo updated')
      await refreshEmployee()
    },
    onError: (mutationError: Error) => toast.error('Could not upload the photo', mutationError.message),
  })

  const removePhotoMutation = useMutation({
    mutationFn: () => del(`/employees/${employeeId}/photo`),
    onSuccess: async () => {
      toast.success('Photo removed')
      setRemovingPhoto(false)
      await refreshEmployee()
    },
    onError: (mutationError: Error) => {
      setRemovingPhoto(false)
      toast.error('Could not remove the photo', mutationError.message)
    },
  })

  // Obvious mistakes are caught here; the server re-checks the real bytes.
  const handleSelectPhoto = (file: File | null): void => {
    setPhotoError(null)
    if (!file) return
    if (!PHOTO_TYPES.includes(file.type)) {
      setPhotoError('The photo must be a PNG or JPEG image')
      return
    }
    if (file.size > PHOTO_MAX_BYTES) {
      setPhotoError('The photo must be 2 MB or smaller')
      return
    }
    photoMutation.mutate(file)
  }

  if (isLoading) return <Spinner label="Loading employee" />
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />
  if (!data) return null

  const isSelf = data.id === user?.employeeId
  const canEdit = can('employee.update')
  const canEditPhoto = canEdit || (isSelf && can('employee.update.self'))
  const canEditDocuments = can('document.upload.any') || (isSelf && can('document.upload.self'))

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'employment', label: 'Employment' },
    { key: 'documents', label: 'Documents & identity' },
    ...(canSeeSalary ? [{ key: 'salary', label: 'Salary' }] : []),
  ]

  const completion = data.profileCompletion

  return (
    <div className="page">
      <PageHeader
        breadcrumbs={[{ label: 'Employees', to: '/employees' }, { label: data.fullName }]}
        title={data.fullName}
        description={`${data.employeeCode}${data.designationName ? ` · ${data.designationName}` : ''}${data.departmentName ? ` · ${data.departmentName}` : ''}`}
        actions={
          canEdit ? (
            <Link to={`/employees/${data.id}/edit`}>
              <Button variant="secondary" icon={<Pencil size={15} />}>
                Edit
              </Button>
            </Link>
          ) : null
        }
      />

      <Card>
        <div className="row" style={{ alignItems: 'center', gap: '1.25rem' }}>
          <div className="stack" style={{ gap: '0.4rem', alignItems: 'center' }}>
            <Avatar name={data.fullName} size={56} src={photoUrl} />
            {canEditPhoto ? (
              <div className="row" style={{ gap: '0.35rem' }}>
                <label className="file-input">
                  <ImageUp size={12} aria-hidden />
                  <span>{photoMutation.isPending ? 'Uploading...' : data.hasPhoto ? 'Replace' : 'Add photo'}</span>
                  <input
                    type="file"
                    accept=".png,.jpg,.jpeg"
                    disabled={photoMutation.isPending}
                    onChange={(event) => {
                      handleSelectPhoto(event.target.files?.[0] ?? null)
                      // Let the same file be chosen again after an error.
                      event.target.value = ''
                    }}
                  />
                </label>
                {data.hasPhoto ? (
                  <Button variant="secondary" size="sm" icon={<Trash2 size={12} />} onClick={() => setRemovingPhoto(true)}>
                    Remove
                  </Button>
                ) : null}
              </div>
            ) : null}
            {photoError ? (
              <p className="field-message field-message-error" role="alert" style={{ fontSize: '0.75rem' }}>
                {photoError}
              </p>
            ) : null}
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <StatusBadge status={data.employmentStatus} />
              <Badge tone="neutral">{humanise(data.employmentType)}</Badge>
              <Badge tone="info">{humanise(data.salaryBasis)} paid</Badge>
              {data.employeeTypeName ? <Badge tone="neutral">{data.employeeTypeName}</Badge> : null}
              {data.plant ? <Badge tone="neutral">{humanise(data.plant)}</Badge> : null}
              {data.isSupervisor ? <Badge tone="accent">Supervisor</Badge> : null}
            </div>
            <p className="subtle" style={{ marginTop: '0.4rem' }}>
              Joined {formatDate(data.joiningDate)}
              {data.supervisorName ? ` · Reports to ${data.supervisorName}` : ''}
            </p>
          </div>
          <div style={{ minWidth: 180 }}>
            <p className="stat-label">Profile completion</p>
            <ProgressBar value={completion.completionPercent} tone={completion.isComplete ? 'success' : 'warning'} />
            <p className="subtle">
              {completion.completedSections} of {completion.totalSections} sections · {completion.completionPercent}%
            </p>
          </div>
        </div>
      </Card>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'overview' ? (
        <div className="grid grid-2">
          <Card title="Personal information">
            <dl className="stack" style={{ gap: '0.3rem' }}>
              <DetailRow label="Full name" value={data.fullName} />
              <DetailRow label="Employee code" value={data.employeeCode} />
              <DetailRow label="Gender" value={humanise(data.gender)} />
              <DetailRow label="Date of birth" value={formatDate(data.dateOfBirth)} />
              <DetailRow label="Marital status" value={humanise(data.maritalStatus)} />
              <DetailRow label="Blood group" value={data.bloodGroup ?? '—'} />
              <DetailRow label="Father's / Mother's name" value={data.parentName ?? '—'} />
              <DetailRow label="Category of skill" value={data.skillCategory ? humanise(data.skillCategory) : '—'} />
              <DetailRow label="Nature of duties" value={data.duties ?? '—'} />
              <DetailRow label="Mobile" value={data.mobileNumber ?? '—'} />
              <DetailRow label="Alternate number" value={data.alternateNumber ?? '—'} />
              <DetailRow label="Work email" value={data.workEmail ?? '—'} />
              <DetailRow label="Personal email" value={data.personalEmail ?? '—'} />
            </dl>
          </Card>

          <Card title="Address and emergency contact">
            {data.addresses.length === 0 ? (
              <p className="muted">No address on file.</p>
            ) : (
              data.addresses.map((address) => (
                <div key={address.id} style={{ marginBottom: '1rem' }}>
                  <p className="stat-label">{humanise(address.addressType)} address</p>
                  <p>
                    {address.addressLine1}
                    {address.addressLine2 ? `, ${address.addressLine2}` : ''}
                    <br />
                    {address.city}, {address.state} {address.pincode}
                    <br />
                    {address.country}
                  </p>
                </div>
              ))
            )}

            {data.emergencyContacts.length === 0 ? (
              <p className="muted">No emergency contact on file.</p>
            ) : (
              data.emergencyContacts.map((contact) => (
                <div key={contact.id}>
                  <p className="stat-label">Emergency contact</p>
                  <p>
                    {contact.name} ({contact.relationship})
                    <br />
                    {contact.phone}
                  </p>
                </div>
              ))
            )}
          </Card>
        </div>
      ) : null}

      {tab === 'employment' ? (
        <Card title="Employment">
          <dl className="stack" style={{ gap: '0.3rem' }}>
            <DetailRow label="Department" value={data.departmentName ?? '—'} />
            <DetailRow label="Section" value={data.designationName ?? '—'} />
            <DetailRow label="Location" value={data.locationName ?? '—'} />
            <DetailRow label="Supervisor" value={data.supervisorName ?? '—'} />
            <DetailRow label="Employment type" value={humanise(data.employmentType)} />
            <DetailRow label="Employment status" value={humanise(data.employmentStatus)} />
            <DetailRow label="Salary basis" value={humanise(data.salaryBasis)} />
            <DetailRow label="Supply type" value={data.employeeTypeName ?? '—'} />
            <DetailRow label="Plant" value={data.plant ? humanise(data.plant) : '—'} />
            <DetailRow label="Joining date" value={formatDate(data.joiningDate)} />
            <DetailRow label="Confirmation date" value={formatDate(data.confirmationDate)} />
            <DetailRow label="Notice start" value={formatDate(data.noticeStartDate)} />
            <DetailRow label="Exit date" value={formatDate(data.exitDate)} />
            <DetailRow label="Exit reason" value={data.exitReason ?? '—'} />
            <DetailRow label="Login" value={data.userEmail ? `${data.userEmail} (${humanise(data.userRole ?? '')})` : 'No login'} />
          </dl>
        </Card>
      ) : null}

      {tab === 'documents' ? <IdentitySection employeeId={data.id} editable={canEditDocuments} /> : null}

      {tab === 'salary' && canSeeSalary ? (
        <div className="stack">
          <Card title="Current salary">
            {salary?.current ? (
              <div className="stack">
                <DetailRow label="Structure" value={salary.current.structureName ?? '—'} />
                <DetailRow label="Basis" value={humanise(salary.current.salaryBasis ?? '')} />
                <DetailRow label="Effective from" value={formatDate(salary.current.effectiveFrom)} />
                <DetailRow
                  label={salary.current.salaryBasis === 'DAILY' ? 'Daily rate' : 'Monthly gross'}
                  value={
                    salary.current.overrideAmount !== null
                      ? formatCurrency(salary.current.overrideAmount)
                      : formatCurrency(salary.currentStructure?.summary.fixedGross ?? null)
                  }
                />

                {salary.currentStructure ? (
                  <div style={{ marginTop: '0.75rem' }}>
                    <p className="stat-label">Components</p>
                    <div className="breakdown-list">
                      {salary.currentStructure.components.map((component) => (
                        <div key={component.id} className="breakdown-row">
                          <span>
                            {component.name}
                            <span className="subtle"> · {humanise(component.componentType)}</span>
                          </span>
                          <span className="numeric">
                            {component.calculationType === 'PERCENTAGE'
                              ? `${component.percentage}%`
                              : formatCurrency(component.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="muted">No salary has been assigned yet.</p>
            )}
          </Card>

          <Card title="Salary history" description="Historical records are never overwritten.">
            {salary && salary.assignments.length > 0 ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Effective from</th>
                    <th>Effective to</th>
                    <th>Structure</th>
                    <th className="align-right">Amount</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {salary.assignments.map((assignment) => (
                    <tr key={assignment.id}>
                      <td data-label="Effective from">{formatDate(assignment.effectiveFrom)}</td>
                      <td data-label="Effective to">{assignment.effectiveTo ? formatDate(assignment.effectiveTo) : 'Current'}</td>
                      <td data-label="Structure">{assignment.structureName}</td>
                      <td data-label="Amount" className="align-right">
                        {assignment.overrideAmount === null ? 'Structure default' : formatCurrency(assignment.overrideAmount)}
                      </td>
                      <td data-label="Notes">{assignment.notes ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No salary history yet.</p>
            )}
          </Card>
        </div>
      ) : null}

      <ConfirmDialog
        open={removingPhoto}
        title="Remove photo"
        message="The initials avatar will be shown instead."
        confirmLabel="Remove"
        tone="danger"
        loading={removePhotoMutation.isPending}
        onConfirm={() => removePhotoMutation.mutate()}
        onCancel={() => setRemovingPhoto(false)}
      />
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="breakdown-row">
      <dt className="muted">{label}</dt>
      <dd style={{ margin: 0, textAlign: 'right' }}>{value}</dd>
    </div>
  )
}
