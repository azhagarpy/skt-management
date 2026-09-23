import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Download, Eye, ShieldCheck, X } from 'lucide-react'
import { download, get, post, put } from '../../lib/api'
import { formatDate, formatFileSize } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Badge, Button, Card, Field, Input, Modal, Select, Spinner, StatusBadge } from '../../components/ui'
import { DocumentUploader } from '../../components/forms/selectors'
import type { IdentityProfile } from '../../types/api'

/**
 * The identity and financial section of an employee profile
 * (plan sections 12-18).
 *
 * Sensitive numbers arrive masked. Revealing one is a separate, audited request,
 * so a screenshot of this page never leaks a full Aadhaar or account number.
 */
export function IdentitySection({ employeeId, editable }: { employeeId: string; editable: boolean }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const { can } = useAuth()

  const [editing, setEditing] = useState<null | 'PAN' | 'AADHAAR' | 'BANK' | 'PF' | 'ESI'>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['employee', employeeId, 'identity'],
    queryFn: () => get<IdentityProfile>(`/employees/${employeeId}/identity`),
  })

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['employee', employeeId] })
    await refetch()
  }

  const reveal = async (section: 'PAN' | 'AADHAAR' | 'BANK'): Promise<void> => {
    try {
      const result = await get<{ section: string; value: string }>(`/employees/${employeeId}/sensitive/${section}`)
      setRevealed((current) => ({ ...current, [section]: result.value }))
    } catch (error) {
      toast.error('Unable to reveal', error instanceof Error ? error.message : undefined)
    }
  }

  const verifyMutation = useMutation({
    mutationFn: (input: { section: string; status: 'VERIFIED' | 'REJECTED'; reason?: string }) =>
      post(`/employees/${employeeId}/verify-section`, input),
    onSuccess: async () => {
      toast.success('Verification updated')
      await invalidate()
    },
    onError: (error: Error) => toast.error('Could not update verification', error.message),
  })

  if (isLoading) return <Spinner />
  if (!data) return null

  const canVerify = can('document.verify')

  interface DetailRow {
    label: string
    value: string
    /** Masked by default; revealing it is a separate audited request. */
    sensitive?: boolean
  }

  interface SectionView {
    key: 'PAN' | 'AADHAAR' | 'BANK' | 'PF' | 'ESI'
    title: string
    status: string | null
    rejection: string | null
    rows: DetailRow[] | null
  }

  const sections: SectionView[] = [
    {
      key: 'PAN',
      title: 'PAN',
      status: data.pan?.verificationStatus ?? null,
      rejection: data.pan?.rejectionReason ?? null,
      rows: data.pan
        ? [
            { label: 'PAN number', value: revealed.PAN ?? data.pan.panMasked ?? '—', sensitive: true },
            { label: 'Name on PAN', value: data.pan.panName },
          ]
        : null,
    },
    {
      key: 'AADHAAR',
      title: 'Aadhaar',
      status: data.aadhaar?.verificationStatus ?? null,
      rejection: data.aadhaar?.rejectionReason ?? null,
      rows: data.aadhaar
        ? [
            { label: 'Aadhaar number', value: revealed.AADHAAR ?? data.aadhaar.aadhaarMasked ?? '—', sensitive: true },
            { label: 'Name on Aadhaar', value: data.aadhaar.aadhaarName },
          ]
        : null,
    },
    {
      key: 'BANK',
      title: 'Bank account',
      status: data.bankAccount?.verificationStatus ?? null,
      rejection: data.bankAccount?.rejectionReason ?? null,
      rows: data.bankAccount
        ? [
            { label: 'Account holder', value: data.bankAccount.accountHolderName },
            { label: 'Bank', value: data.bankAccount.bankName },
            { label: 'Account number', value: revealed.BANK ?? data.bankAccount.accountMasked ?? '—', sensitive: true },
            { label: 'IFSC', value: data.bankAccount.ifscCode },
            { label: 'Branch', value: data.bankAccount.branchName ?? '—' },
            { label: 'Type', value: data.bankAccount.accountType },
          ]
        : null,
    },
    {
      key: 'PF',
      title: 'Provident fund',
      status: data.pf?.verificationStatus ?? null,
      rejection: data.pf?.rejectionReason ?? null,
      rows: data.pf
        ? [
            { label: 'PF applicable', value: data.pf.pfApplicable ? 'Yes' : 'No' },
            { label: 'UAN', value: data.pf.uanNumber ?? '—' },
            { label: 'Member ID', value: data.pf.pfMemberId ?? '—' },
            { label: 'Name (as per PF)', value: data.pf.pfName ?? '—' },
            { label: 'Pension applicable', value: data.pf.pensionApplicable ? 'Yes' : 'No' },
          ]
        : null,
    },
    {
      key: 'ESI',
      title: 'ESI',
      status: data.esi?.verificationStatus ?? null,
      rejection: data.esi?.rejectionReason ?? null,
      rows: data.esi
        ? [
            { label: 'ESI applicable', value: data.esi.esiApplicable ? 'Yes' : 'No' },
            { label: 'ESI number', value: data.esi.esiNumber ?? '—' },
            { label: 'Name (as per ESI)', value: data.esi.esiName ?? '—' },
          ]
        : null,
    },
  ]

  return (
    <div className="stack">
      {sections.map((section) => (
        <Card
          key={section.key}
          title={section.title}
          actions={
            <>
              {section.status ? <StatusBadge status={section.status} /> : <Badge tone="warning">Not provided</Badge>}
              {editable ? (
                <Button variant="secondary" size="sm" onClick={() => setEditing(section.key)}>
                  {section.rows ? 'Update' : 'Add'}
                </Button>
              ) : null}
              {canVerify && section.rows ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Check size={14} />}
                    onClick={() => verifyMutation.mutate({ section: section.key, status: 'VERIFIED' })}
                  >
                    Verify
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<X size={14} />}
                    onClick={() => {
                      const reason = window.prompt('Why is this being rejected?')
                      if (reason) verifyMutation.mutate({ section: section.key, status: 'REJECTED', reason })
                    }}
                  >
                    Reject
                  </Button>
                </>
              ) : null}
            </>
          }
        >
          {section.rows ? (
            <div className="stack" style={{ gap: '0.3rem' }}>
              {section.rows.map((row) => (
                <div key={row.label} className="breakdown-row">
                  <span className="muted">{row.label}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span className="mono">{row.value}</span>
                    {row.sensitive && !revealed[section.key] ? (
                      <button
                        type="button"
                        className="icon-button"
                        style={{ width: 26, height: 26 }}
                        onClick={() => void reveal(section.key as 'PAN' | 'AADHAAR' | 'BANK')}
                        aria-label={`Reveal ${row.label}`}
                        title="Revealing is recorded in the audit log"
                      >
                        <Eye size={13} />
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
              {section.rejection ? (
                <p className="field-message field-message-error">Rejected: {section.rejection}</p>
              ) : null}
            </div>
          ) : (
            <p className="muted">Not provided yet.</p>
          )}
        </Card>
      ))}

      <Card title="Documents" description="PDF, JPG or PNG up to 10 MB. Files are served only to people who may see them.">
        {editable ? (
          <div style={{ marginBottom: '1rem' }}>
            <DocumentUploader employeeId={employeeId} category="OTHER" onUploaded={() => void invalidate()} />
          </div>
        ) : null}

        {data.documents.length === 0 ? (
          <p className="muted">No documents uploaded yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Category</th>
                <th>Size</th>
                <th>Status</th>
                <th>Uploaded</th>
                <th className="align-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.documents.map((document) => (
                <tr key={document.id}>
                  <td data-label="Document">{document.title}</td>
                  <td data-label="Category">{document.category}</td>
                  <td data-label="Size">{formatFileSize(document.fileSizeBytes)}</td>
                  <td data-label="Status">
                    <StatusBadge status={document.verificationStatus} />
                  </td>
                  <td data-label="Uploaded">{formatDate(document.createdAt)}</td>
                  <td data-label="Actions" className="align-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Download size={14} />}
                      onClick={() =>
                        void download(
                          `/employees/${employeeId}/documents/${document.id}/file`,
                          document.originalFilename,
                        )
                      }
                    >
                      Download
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <IdentityEditModal
        employeeId={employeeId}
        section={editing}
        profile={data}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          void invalidate()
        }}
      />
    </div>
  )
}

/** One modal, five shapes: each section posts to its own endpoint. */
function IdentityEditModal({
  employeeId,
  section,
  profile,
  onClose,
  onSaved,
}: {
  employeeId: string
  section: null | 'PAN' | 'AADHAAR' | 'BANK' | 'PF' | 'ESI'
  profile: IdentityProfile
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const set = (key: string, value: string): void => setValues((current) => ({ ...current, [key]: value }))

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      if (section === 'PAN') {
        await put(`/employees/${employeeId}/pan`, {
          panNumber: values.panNumber ?? '',
          panName: values.panName ?? '',
        })
      } else if (section === 'AADHAAR') {
        await put(`/employees/${employeeId}/aadhaar`, {
          aadhaarNumber: values.aadhaarNumber ?? '',
          aadhaarName: values.aadhaarName ?? '',
        })
      } else if (section === 'BANK') {
        await put(`/employees/${employeeId}/bank-account`, {
          accountHolderName: values.accountHolderName ?? '',
          bankName: values.bankName ?? '',
          accountNumber: values.accountNumber ?? '',
          confirmAccountNumber: values.confirmAccountNumber ?? '',
          ifscCode: values.ifscCode ?? '',
          branchName: values.branchName || null,
          accountType: values.accountType || 'SAVINGS',
          isPrimary: true,
        })
      } else if (section === 'PF') {
        await put(`/employees/${employeeId}/pf`, {
          pfApplicable: values.pfApplicable !== 'false',
          uanNumber: values.uanNumber || null,
          pfMemberId: values.pfMemberId || null,
          pfName: values.pfName || null,
          pensionApplicable: values.pensionApplicable !== 'false',
        })
      } else if (section === 'ESI') {
        await put(`/employees/${employeeId}/esi`, {
          esiApplicable: values.esiApplicable === 'true',
          esiNumber: values.esiNumber || null,
          esiName: values.esiName || null,
        })
      }
      toast.success('Saved', 'The details will need to be verified again.')
      setValues({})
      onSaved()
    } catch (error) {
      toast.error('Could not save', error instanceof Error ? error.message : undefined)
    } finally {
      setSaving(false)
    }
  }

  if (!section) return null

  const titles: Record<string, string> = {
    PAN: 'PAN details',
    AADHAAR: 'Aadhaar details',
    BANK: 'Bank account',
    PF: 'Provident fund',
    ESI: 'ESI',
  }

  return (
    <Modal
      open
      title={titles[section] ?? 'Details'}
      description="Changing these details resets their verification status."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} icon={<ShieldCheck size={15} />}>
            Save details
          </Button>
        </>
      }
    >
      <div className="stack">
        {section === 'PAN' ? (
          <>
            <Field label="PAN number" htmlFor="panNumber" required hint="Format: ABCDE1234F">
              <Input
                id="panNumber"
                defaultValue=""
                maxLength={10}
                style={{ textTransform: 'uppercase' }}
                onChange={(event) => set('panNumber', event.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Name as printed on the PAN" htmlFor="panName" required>
              <Input
                id="panName"
                defaultValue={profile.pan?.panName ?? ''}
                onChange={(event) => set('panName', event.target.value)}
              />
            </Field>
          </>
        ) : null}

        {section === 'AADHAAR' ? (
          <>
            <Field label="Aadhaar number" htmlFor="aadhaarNumber" required hint="12 digits">
              <Input
                id="aadhaarNumber"
                inputMode="numeric"
                maxLength={14}
                onChange={(event) => set('aadhaarNumber', event.target.value)}
              />
            </Field>
            <Field label="Name as printed on the Aadhaar" htmlFor="aadhaarName" required>
              <Input
                id="aadhaarName"
                defaultValue={profile.aadhaar?.aadhaarName ?? ''}
                onChange={(event) => set('aadhaarName', event.target.value)}
              />
            </Field>
          </>
        ) : null}

        {section === 'BANK' ? (
          <>
            <Field label="Account holder name" htmlFor="accountHolderName" required>
              <Input
                id="accountHolderName"
                defaultValue={profile.bankAccount?.accountHolderName ?? ''}
                onChange={(event) => set('accountHolderName', event.target.value)}
              />
            </Field>
            <Field label="Bank name" htmlFor="bankName" required>
              <Input
                id="bankName"
                defaultValue={profile.bankAccount?.bankName ?? ''}
                onChange={(event) => set('bankName', event.target.value)}
              />
            </Field>
            <Field label="Account number" htmlFor="accountNumber" required>
              <Input id="accountNumber" inputMode="numeric" onChange={(event) => set('accountNumber', event.target.value)} />
            </Field>
            <Field label="Confirm account number" htmlFor="confirmAccountNumber" required>
              <Input
                id="confirmAccountNumber"
                inputMode="numeric"
                onChange={(event) => set('confirmAccountNumber', event.target.value)}
              />
            </Field>
            <Field label="IFSC code" htmlFor="ifscCode" required hint="Format: HDFC0001234">
              <Input
                id="ifscCode"
                maxLength={11}
                defaultValue={profile.bankAccount?.ifscCode ?? ''}
                style={{ textTransform: 'uppercase' }}
                onChange={(event) => set('ifscCode', event.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Branch" htmlFor="branchName">
              <Input
                id="branchName"
                defaultValue={profile.bankAccount?.branchName ?? ''}
                onChange={(event) => set('branchName', event.target.value)}
              />
            </Field>
            <Field label="Account type" htmlFor="accountType">
              <Select
                id="accountType"
                defaultValue={profile.bankAccount?.accountType ?? 'SAVINGS'}
                onChange={(event) => set('accountType', event.target.value)}
              >
                <option value="SAVINGS">Savings</option>
                <option value="CURRENT">Current</option>
                <option value="OTHER">Other</option>
              </Select>
            </Field>
          </>
        ) : null}

        {section === 'PF' ? (
          <>
            <Field label="PF applicable" htmlFor="pfApplicable">
              <Select
                id="pfApplicable"
                defaultValue={profile.pf?.pfApplicable === false ? 'false' : 'true'}
                onChange={(event) => set('pfApplicable', event.target.value)}
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            </Field>
            <Field label="UAN" htmlFor="uanNumber" hint="12 digits">
              <Input
                id="uanNumber"
                inputMode="numeric"
                maxLength={12}
                defaultValue={profile.pf?.uanNumber ?? ''}
                onChange={(event) => set('uanNumber', event.target.value)}
              />
            </Field>
            <Field label="PF member ID" htmlFor="pfMemberId">
              <Input
                id="pfMemberId"
                defaultValue={profile.pf?.pfMemberId ?? ''}
                onChange={(event) => set('pfMemberId', event.target.value)}
              />
            </Field>
            <Field label="Name (as per PF)" htmlFor="pfName">
              <Input
                id="pfName"
                defaultValue={profile.pf?.pfName ?? ''}
                onChange={(event) => set('pfName', event.target.value)}
              />
            </Field>
            <Field label="Pension applicable" htmlFor="pensionApplicable" hint="Whether the employee is enrolled in the Pension Scheme (EPS)">
              <Select
                id="pensionApplicable"
                defaultValue={profile.pf?.pensionApplicable === false ? 'false' : 'true'}
                onChange={(event) => set('pensionApplicable', event.target.value)}
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            </Field>
          </>
        ) : null}

        {section === 'ESI' ? (
          <>
            <Field label="ESI applicable" htmlFor="esiApplicable">
              <Select
                id="esiApplicable"
                defaultValue={profile.esi?.esiApplicable ? 'true' : 'false'}
                onChange={(event) => set('esiApplicable', event.target.value)}
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            </Field>
            <Field label="ESI number" htmlFor="esiNumber">
              <Input
                id="esiNumber"
                inputMode="numeric"
                defaultValue={profile.esi?.esiNumber ?? ''}
                onChange={(event) => set('esiNumber', event.target.value)}
              />
            </Field>
            <Field label="Name (as per ESI)" htmlFor="esiName" hint="Only alphabets and spaces">
              <Input
                id="esiName"
                defaultValue={profile.esi?.esiName ?? ''}
                onChange={(event) => set('esiName', event.target.value)}
              />
            </Field>
          </>
        ) : null}
      </div>
    </Modal>
  )
}
