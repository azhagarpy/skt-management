import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ImageUp, Plus, Save, Trash2 } from 'lucide-react'
import { del, get, patch, post, upload } from '../../lib/api'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import {
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  PageHeader,
  Spinner,
  StatusBadge,
  Tabs,
} from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import type { Department, Designation, Location, OrganizationProfile } from '../../types/api'
import {
  DEFAULT_THEME_COLOR,
  THEME_PRESETS,
  brandRamp,
  useBranding,
} from '../../app/providers/BrandingProvider'

/** Organization profile, departments, sections and locations. */
export default function OrganizationPage() {
  const { can } = useAuth()
  const [tab, setTab] = useState('profile')

  return (
    <div className="page">
      <PageHeader title="Organization" description="Company details and the structures employees are assigned to." />

      <Tabs
        tabs={[
          { key: 'profile', label: 'Profile' },
          { key: 'branding', label: 'Branding' },
          { key: 'departments', label: 'Departments' },
          { key: 'designations', label: 'Sections' },
          { key: 'locations', label: 'Locations' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'profile' ? <ProfileTab canManage={can('org.manage')} /> : null}
      {tab === 'branding' ? <BrandingTab canManage={can('org.manage')} /> : null}
      {tab === 'departments' ? <DepartmentsTab canManage={can('department.manage')} /> : null}
      {tab === 'designations' ? <DesignationsTab canManage={can('designation.manage')} /> : null}
      {tab === 'locations' ? <LocationsTab canManage={can('location.manage')} /> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  name: z.string().trim().min(2, 'A name is required').max(160),
  legalName: z.string().trim().max(200).optional().or(z.literal('')),
  email: z.string().trim().email('Enter a valid email').optional().or(z.literal('')),
  phone: z.string().trim().optional().or(z.literal('')),
  website: z.string().trim().optional().or(z.literal('')),
  addressLine1: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().max(100).optional().or(z.literal('')),
  state: z.string().trim().max(100).optional().or(z.literal('')),
  pincode: z.string().trim().optional().or(z.literal('')),
  pfNumber: z.string().trim().max(40).optional().or(z.literal('')),
  esiNumber: z.string().trim().max(60).optional().or(z.literal('')),
  labourIdentificationNumber: z.string().trim().max(40).optional().or(z.literal('')),
})

type ProfileValues = z.infer<typeof profileSchema>

function ProfileTab({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['organization'],
    queryFn: () => get<OrganizationProfile>('/organization'),
  })

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ProfileValues>({ resolver: zodResolver(profileSchema) })

  useEffect(() => {
    if (!data) return
    reset({
      name: data.name ?? '',
      legalName: data.legalName ?? '',
      email: data.email ?? '',
      phone: data.phone ?? '',
      website: data.website ?? '',
      addressLine1: data.addressLine1 ?? '',
      city: data.city ?? '',
      state: data.state ?? '',
      pincode: data.pincode ?? '',
      pfNumber: data.pfNumber ?? '',
      esiNumber: data.esiNumber ?? '',
      labourIdentificationNumber: data.labourIdentificationNumber ?? '',
    })
  }, [data, reset])

  const mutation = useMutation({
    mutationFn: (values: ProfileValues) => {
      const blank = (value: string | undefined): string | null => (value && value.trim() !== '' ? value.trim() : null)
      return patch('/organization', {
        name: values.name,
        legalName: blank(values.legalName),
        email: blank(values.email),
        phone: blank(values.phone),
        website: blank(values.website),
        addressLine1: blank(values.addressLine1),
        city: blank(values.city),
        state: blank(values.state),
        pincode: blank(values.pincode),
        pfNumber: blank(values.pfNumber),
        esiNumber: blank(values.esiNumber),
        labourIdentificationNumber: blank(values.labourIdentificationNumber),
      })
    },
    onSuccess: async () => {
      toast.success('Organization updated')
      await queryClient.invalidateQueries({ queryKey: ['organization'] })
    },
    onError: (error: Error) => toast.error('Could not save', error.message),
  })

  if (isLoading) return <Spinner />

  return (
    <Card title="Company profile" description="These details appear on payslips and exported reports.">
      <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="stack" noValidate>
        <div className="grid grid-2">
          <Field label="Name" htmlFor="org-name" error={errors.name?.message} required>
            <Input id="org-name" disabled={!canManage} {...register('name')} />
          </Field>
          <Field label="Legal name" htmlFor="org-legal">
            <Input id="org-legal" disabled={!canManage} {...register('legalName')} />
          </Field>
          <Field label="Email" htmlFor="org-email" error={errors.email?.message}>
            <Input id="org-email" type="email" disabled={!canManage} {...register('email')} />
          </Field>
          <Field label="Phone" htmlFor="org-phone">
            <Input id="org-phone" type="tel" disabled={!canManage} {...register('phone')} />
          </Field>
          <Field label="Website" htmlFor="org-website">
            <Input id="org-website" disabled={!canManage} {...register('website')} />
          </Field>
          <Field label="Address" htmlFor="org-address">
            <Input id="org-address" disabled={!canManage} {...register('addressLine1')} />
          </Field>
          <Field label="City" htmlFor="org-city">
            <Input id="org-city" disabled={!canManage} {...register('city')} />
          </Field>
          <Field label="State" htmlFor="org-state">
            <Input id="org-state" disabled={!canManage} {...register('state')} />
          </Field>
          <Field label="Pincode" htmlFor="org-pincode">
            <Input id="org-pincode" disabled={!canManage} {...register('pincode')} />
          </Field>
          <Field label="PF number" htmlFor="org-pf">
            <Input id="org-pf" disabled={!canManage} {...register('pfNumber')} />
          </Field>
          <Field label="ESI number" htmlFor="org-esi">
            <Input id="org-esi" disabled={!canManage} {...register('esiNumber')} />
          </Field>
          <Field
            label="Labour Identification Number"
            htmlFor="org-lin"
            hint="The establishment's LIN, printed on every Letter of Appointment."
          >
            <Input id="org-lin" disabled={!canManage} {...register('labourIdentificationNumber')} />
          </Field>
        </div>

        {canManage ? (
          <div>
            <Button type="submit" loading={isSubmitting || mutation.isPending} icon={<Save size={15} />}>
              Save changes
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

const LOGO_TYPES = ['image/png', 'image/jpeg']
const LOGO_MAX_BYTES = 2 * 1024 * 1024

/**
 * Name, logo and accent colour.
 *
 * The name is edited on the Profile tab, since it is the same field; this tab
 * owns the two that only exist for branding. Saving invalidates the
 * organization query, which is what the branding provider reads, so the whole
 * shell repaints without a reload.
 */
function BrandingTab({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const branding = useBranding()

  const { data, isLoading } = useQuery({
    queryKey: ['organization'],
    queryFn: () => get<OrganizationProfile>('/organization'),
  })

  const [colour, setColour] = useState<string | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)

  const saved = data?.themeColor ?? DEFAULT_THEME_COLOR
  const selected = colour ?? saved
  const isValidColour = /^#[0-9a-f]{6}$/i.test(selected)
  const dirty = selected.toLowerCase() !== saved.toLowerCase()

  const refreshBranding = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['organization'] })
  }

  const colourMutation = useMutation({
    mutationFn: () => patch('/organization', { themeColor: selected.toLowerCase() }),
    onSuccess: async () => {
      toast.success('Theme colour updated')
      setColour(null)
      await refreshBranding()
    },
    onError: (error: Error) => toast.error('Could not save the colour', error.message),
  })

  const logoMutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return upload('/organization/logo', formData)
    },
    onSuccess: async () => {
      toast.success('Logo updated')
      await refreshBranding()
    },
    onError: (error: Error) => toast.error('Could not upload the logo', error.message),
  })

  const removeLogoMutation = useMutation({
    mutationFn: () => del('/organization/logo'),
    onSuccess: async () => {
      toast.success('Logo removed')
      setRemoving(false)
      await refreshBranding()
    },
    onError: (error: Error) => {
      setRemoving(false)
      toast.error('Could not remove the logo', error.message)
    },
  })

  // Obvious mistakes are caught here; the server re-checks the real bytes.
  const handleSelect = (file: File | null): void => {
    setLogoError(null)
    if (!file) return
    if (!LOGO_TYPES.includes(file.type)) {
      setLogoError('The logo must be a PNG or JPEG image')
      return
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError('The logo must be 2 MB or smaller')
      return
    }
    logoMutation.mutate(file)
  }

  if (isLoading) return <Spinner />

  const previewRamp = isValidColour ? brandRamp(selected) : null

  return (
    <div className="stack">
      <Card title="Logo" description="Shown in the sidebar. A square PNG or JPEG up to 2 MB works best.">
        <div className="stack">
          <div className="branding-preview">
            {branding.logoUrl ? (
              <img className="branding-preview-logo" src={branding.logoUrl} alt="Current logo" />
            ) : (
              <span className="branding-preview-mark" aria-hidden>
                {branding.initials}
              </span>
            )}
            <div>
              <strong>{branding.name}</strong>
              <p className="subtle">{data?.hasLogo ? 'Current logo' : 'No logo set - initials are shown instead'}</p>
            </div>
          </div>

          {canManage ? (
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              <label className="file-input">
                <ImageUp size={14} aria-hidden />
                <span>{logoMutation.isPending ? 'Uploading...' : data?.hasLogo ? 'Replace logo' : 'Upload logo'}</span>
                <input
                  type="file"
                  accept=".png,.jpg,.jpeg"
                  disabled={logoMutation.isPending}
                  onChange={(event) => {
                    handleSelect(event.target.files?.[0] ?? null)
                    // Let the same file be chosen again after an error.
                    event.target.value = ''
                  }}
                />
              </label>
              {data?.hasLogo ? (
                <Button variant="secondary" icon={<Trash2 size={14} />} onClick={() => setRemoving(true)}>
                  Remove
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="subtle">You do not have permission to change the logo.</p>
          )}

          {logoError ? (
            <p className="field-message field-message-error" role="alert">
              {logoError}
            </p>
          ) : null}
        </div>
      </Card>

      <Card
        title="Theme colour"
        description="One colour drives the whole accent ramp - buttons, links, the sidebar and the active states."
      >
        <div className="stack">
          <div className="swatch-grid">
            {THEME_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className="swatch"
                style={{ background: preset.value }}
                title={preset.label}
                aria-label={preset.label}
                aria-pressed={selected.toLowerCase() === preset.value}
                disabled={!canManage}
                onClick={() => setColour(preset.value)}
              />
            ))}
          </div>

          <div className="grid grid-2">
            <Field label="Custom colour" htmlFor="theme-colour" hint="Any 6-digit hex value, for example #5b54d6.">
              <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="color"
                  aria-label="Pick a colour"
                  value={isValidColour ? selected : DEFAULT_THEME_COLOR}
                  disabled={!canManage}
                  onChange={(event) => setColour(event.target.value)}
                  style={{ width: 42, height: 34, padding: 2, border: 0, background: 'none' }}
                />
                <Input
                  id="theme-colour"
                  value={selected}
                  disabled={!canManage}
                  onChange={(event) => setColour(event.target.value)}
                />
              </div>
            </Field>

            <Field label="Preview">
              {previewRamp ? (
                <div className="swatch-grid" aria-hidden>
                  {Object.entries(previewRamp).map(([token, value]) => (
                    <span key={token} className="swatch" style={{ background: value, cursor: 'default' }} title={value} />
                  ))}
                </div>
              ) : (
                <p className="field-message field-message-error" role="alert">
                  Enter a colour as a 6-digit hex value.
                </p>
              )}
            </Field>
          </div>

          {canManage ? (
            <div className="row" style={{ gap: '0.5rem' }}>
              <Button
                icon={<Save size={15} />}
                loading={colourMutation.isPending}
                disabled={!dirty || !isValidColour}
                onClick={() => colourMutation.mutate()}
              >
                Save colour
              </Button>
              {dirty ? (
                <Button variant="secondary" onClick={() => setColour(null)}>
                  Reset
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="subtle">You do not have permission to change the theme colour.</p>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={removing}
        title="Remove logo"
        message="The sidebar will fall back to the organization initials."
        confirmLabel="Remove"
        tone="danger"
        loading={removeLogoMutation.isPending}
        onConfirm={() => removeLogoMutation.mutate()}
        onCancel={() => setRemoving(false)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared CRUD tab for departments, sections and locations
// ---------------------------------------------------------------------------

interface SimpleEntity {
  id: string
  name: string
  code: string
  isActive: boolean
  employeeCount?: number
}

function SimpleCrudTab<T extends SimpleEntity>({
  title,
  description,
  endpoint,
  queryKey,
  canManage,
  extraColumns = [],
}: {
  title: string
  description: string
  endpoint: string
  queryKey: string
  canManage: boolean
  extraColumns?: Column<T>[]
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<T | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<T | null>(null)
  const [form, setForm] = useState({ name: '', code: '', isActive: true })

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: [queryKey, 'manage'],
    queryFn: () => get<T[]>(endpoint, { includeCounts: true }),
  })

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = { name: form.name, code: form.code.toUpperCase(), isActive: form.isActive }
      return editing ? patch(`${endpoint}/${editing.id}`, payload) : post(endpoint, payload)
    },
    onSuccess: async () => {
      toast.success(`${title} saved`)
      setCreating(false)
      setEditing(null)
      await queryClient.invalidateQueries({ queryKey: [queryKey] })
    },
    onError: (mutationError: Error) => toast.error('Could not save', mutationError.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (entity: T) => del(`${endpoint}/${entity.id}`),
    onSuccess: async () => {
      toast.success('Removed')
      setDeleteTarget(null)
      await queryClient.invalidateQueries({ queryKey: [queryKey] })
    },
    onError: (mutationError: Error) => {
      setDeleteTarget(null)
      toast.error('Could not remove', mutationError.message)
    },
  })

  const columns: Column<T>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <div>
          <strong>{row.name}</strong>
          <p className="subtle">{row.code}</p>
        </div>
      ),
    },
    ...extraColumns,
    {
      key: 'employees',
      header: 'Employees',
      align: 'right',
      render: (row) => (row.employeeCount === undefined ? '—' : row.employeeCount),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            render: (row: T) => (
              <div style={{ display: 'inline-flex', gap: '0.3rem' }}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setForm({ name: row.name, code: row.code, isActive: row.isActive })
                    setEditing(row)
                  }}
                >
                  Edit
                </Button>
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDeleteTarget(row)} />
              </div>
            ),
          },
        ]
      : []),
  ]

  return (
    <Card
      title={title}
      description={description}
      actions={
        canManage ? (
          <Button
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => {
              setForm({ name: '', code: '', isActive: true })
              setCreating(true)
            }}
          >
            Add
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
        emptyTitle={`No ${title.toLowerCase()} yet`}
        caption={title}
      />

      <Modal
        open={creating || editing !== null}
        title={editing ? `Edit ${editing.name}` : `Add ${title.toLowerCase().replace(/s$/, '')}`}
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
            <Button loading={saveMutation.isPending} disabled={!form.name || !form.code} onClick={() => saveMutation.mutate()}>
              Save
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="Name" htmlFor="entity-name" required>
            <Input id="entity-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Code" htmlFor="entity-code" required>
            <Input
              id="entity-code"
              value={form.code}
              style={{ textTransform: 'uppercase' }}
              onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })}
            />
          </Field>
          <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
            <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
            <span>Active</span>
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove"
        message={`Remove ${deleteTarget?.name}? This is refused if employees are still assigned to it.`}
        confirmLabel="Remove"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  )
}

function DepartmentsTab({ canManage }: { canManage: boolean }) {
  return (
    <SimpleCrudTab<Department>
      title="Departments"
      description="Departments group employees, and can carry their own weekly off rules."
      endpoint="/departments"
      queryKey="departments"
      canManage={canManage}
    />
  )
}

function DesignationsTab({ canManage }: { canManage: boolean }) {
  return (
    <SimpleCrudTab<Designation>
      title="Sections"
      description="Sections employees can be assigned to."
      endpoint="/designations"
      queryKey="designations"
      canManage={canManage}
    />
  )
}

function LocationsTab({ canManage }: { canManage: boolean }) {
  return (
    <SimpleCrudTab<Location>
      title="Locations"
      description="Work locations. Weekly off rules and holiday calendars can be scoped to a location."
      endpoint="/locations"
      queryKey="locations"
      canManage={canManage}
      extraColumns={[
        {
          key: 'city',
          header: 'City',
          hideOnMobile: true,
          render: (row) => row.city ?? <span className="subtle">—</span>,
        },
      ]}
    />
  )
}
