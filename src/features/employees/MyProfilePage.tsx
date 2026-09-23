import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save } from 'lucide-react'
import { get, patch } from '../../lib/api'
import { formatDate, humanise } from '../../lib/format'
import { useToast } from '../../app/providers/ToastProvider'
import {
  Avatar,
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  PageHeader,
  ProgressBar,
  Select,
  Spinner,
  StatusBadge,
  Tabs,
} from '../../components/ui'
import { IdentitySection } from './IdentitySection'
import type { EmployeeDetail } from '../../types/api'

/**
 * Employee self-service.
 *
 * Only the fields the plan allows an employee to change are editable here; their
 * department, salary and employment status are read-only (plan section 3).
 */

const schema = z.object({
  personalEmail: z.string().trim().email('Enter a valid email').optional().or(z.literal('')),
  mobileNumber: z.string().trim().optional().or(z.literal('')),
  alternateNumber: z.string().trim().optional().or(z.literal('')),
  maritalStatus: z.enum(['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'UNDISCLOSED']),
  bloodGroup: z.string().trim().max(8).optional().or(z.literal('')),
  addressLine1: z.string().trim().min(3, 'Address is required').max(200),
  addressLine2: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().min(2, 'City is required').max(100),
  state: z.string().trim().min(2, 'State is required').max(100),
  pincode: z.string().trim().regex(/^[0-9]{4,10}$/, 'Enter a valid pincode'),
  contactName: z.string().trim().min(2, 'Contact name is required').max(120),
  contactRelationship: z.string().trim().min(2, 'Relationship is required').max(60),
  contactPhone: z.string().trim().min(6, 'Contact phone is required').max(20),
})

type FormValues = z.infer<typeof schema>

export default function MyProfilePage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState('details')

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['employee', 'me'],
    queryFn: () => get<EmployeeDetail>('/employees/me'),
  })

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      personalEmail: '',
      mobileNumber: '',
      alternateNumber: '',
      maritalStatus: 'UNDISCLOSED',
      bloodGroup: '',
      addressLine1: '',
      addressLine2: '',
      city: '',
      state: '',
      pincode: '',
      contactName: '',
      contactRelationship: '',
      contactPhone: '',
    },
  })

  useEffect(() => {
    if (!data) return
    const address = data.addresses.find((entry) => entry.addressType === 'CURRENT') ?? data.addresses[0]
    const contact = data.emergencyContacts.find((entry) => entry.isPrimary) ?? data.emergencyContacts[0]

    reset({
      personalEmail: data.personalEmail ?? '',
      mobileNumber: data.mobileNumber ?? '',
      alternateNumber: data.alternateNumber ?? '',
      maritalStatus: (data.maritalStatus as FormValues['maritalStatus']) ?? 'UNDISCLOSED',
      bloodGroup: data.bloodGroup ?? '',
      addressLine1: address?.addressLine1 ?? '',
      addressLine2: address?.addressLine2 ?? '',
      city: address?.city ?? '',
      state: address?.state ?? '',
      pincode: address?.pincode ?? '',
      contactName: contact?.name ?? '',
      contactRelationship: contact?.relationship ?? '',
      contactPhone: contact?.phone ?? '',
    })
  }, [data, reset])

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      patch<EmployeeDetail>('/employees/me', {
        personalEmail: values.personalEmail || null,
        mobileNumber: values.mobileNumber || null,
        alternateNumber: values.alternateNumber || null,
        maritalStatus: values.maritalStatus,
        bloodGroup: values.bloodGroup || null,
        address: {
          addressType: 'CURRENT',
          addressLine1: values.addressLine1,
          addressLine2: values.addressLine2 || null,
          city: values.city,
          state: values.state,
          country: 'India',
          pincode: values.pincode,
        },
        emergencyContact: {
          name: values.contactName,
          relationship: values.contactRelationship,
          phone: values.contactPhone,
          isPrimary: true,
        },
      }),
    onSuccess: async () => {
      toast.success('Profile updated')
      await queryClient.invalidateQueries({ queryKey: ['employee', 'me'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (mutationError: Error) => toast.error('Could not save', mutationError.message),
  })

  if (isLoading) return <Spinner label="Loading your profile" />
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />
  if (!data) return null

  const completion = data.profileCompletion

  return (
    <div className="page">
      <PageHeader title="My profile" description="Keep your contact details and documents up to date." />

      <Card>
        <div className="row" style={{ alignItems: 'center', gap: '1.25rem' }}>
          <Avatar name={data.fullName} size={56} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <p style={{ fontWeight: 600, fontSize: '1rem' }}>{data.fullName}</p>
            <p className="subtle">
              {data.employeeCode}
              {data.designationName ? ` · ${data.designationName}` : ''}
              {data.departmentName ? ` · ${data.departmentName}` : ''}
            </p>
            <div className="row" style={{ gap: '0.4rem', marginTop: '0.4rem' }}>
              <StatusBadge status={data.employmentStatus} />
              <Badge tone="neutral">{humanise(data.employmentType)}</Badge>
              <Badge tone="info">Joined {formatDate(data.joiningDate)}</Badge>
            </div>
          </div>
          <div style={{ minWidth: 180 }}>
            <p className="stat-label">Profile completion</p>
            <ProgressBar value={completion.completionPercent} tone={completion.isComplete ? 'success' : 'warning'} />
            <p className="subtle">{completion.completionPercent}% complete</p>
          </div>
        </div>
      </Card>

      <Tabs
        tabs={[
          { key: 'details', label: 'My details' },
          { key: 'documents', label: 'Documents & identity' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'details' ? (
        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="stack" noValidate>
          <Card title="Contact details" description="Your name, department and salary are managed by HR.">
            <div className="grid grid-2">
              <Field label="Personal email" htmlFor="personalEmail" error={errors.personalEmail?.message}>
                <Input id="personalEmail" type="email" {...register('personalEmail')} />
              </Field>
              <Field label="Mobile number" htmlFor="mobileNumber" error={errors.mobileNumber?.message}>
                <Input id="mobileNumber" type="tel" {...register('mobileNumber')} />
              </Field>
              <Field label="Alternate number" htmlFor="alternateNumber">
                <Input id="alternateNumber" type="tel" {...register('alternateNumber')} />
              </Field>
              <Field label="Marital status" htmlFor="maritalStatus">
                <Select id="maritalStatus" {...register('maritalStatus')}>
                  <option value="UNDISCLOSED">Prefer not to say</option>
                  <option value="SINGLE">Single</option>
                  <option value="MARRIED">Married</option>
                  <option value="DIVORCED">Divorced</option>
                  <option value="WIDOWED">Widowed</option>
                </Select>
              </Field>
              <Field label="Blood group" htmlFor="bloodGroup">
                <Input id="bloodGroup" maxLength={8} {...register('bloodGroup')} />
              </Field>
            </div>
          </Card>

          <Card title="Current address">
            <div className="grid grid-2">
              <Field label="Address line 1" htmlFor="addressLine1" error={errors.addressLine1?.message} required>
                <Input id="addressLine1" {...register('addressLine1')} />
              </Field>
              <Field label="Address line 2" htmlFor="addressLine2">
                <Input id="addressLine2" {...register('addressLine2')} />
              </Field>
              <Field label="City" htmlFor="city" error={errors.city?.message} required>
                <Input id="city" {...register('city')} />
              </Field>
              <Field label="State" htmlFor="state" error={errors.state?.message} required>
                <Input id="state" {...register('state')} />
              </Field>
              <Field label="Pincode" htmlFor="pincode" error={errors.pincode?.message} required>
                <Input id="pincode" inputMode="numeric" {...register('pincode')} />
              </Field>
            </div>
          </Card>

          <Card title="Emergency contact">
            <div className="grid grid-2">
              <Field label="Name" htmlFor="contactName" error={errors.contactName?.message} required>
                <Input id="contactName" {...register('contactName')} />
              </Field>
              <Field label="Relationship" htmlFor="contactRelationship" error={errors.contactRelationship?.message} required>
                <Input id="contactRelationship" {...register('contactRelationship')} />
              </Field>
              <Field label="Phone" htmlFor="contactPhone" error={errors.contactPhone?.message} required>
                <Input id="contactPhone" type="tel" {...register('contactPhone')} />
              </Field>
            </div>
          </Card>

          <div>
            <Button type="submit" loading={isSubmitting || mutation.isPending} icon={<Save size={15} />}>
              Save changes
            </Button>
          </div>
        </form>
      ) : (
        <IdentitySection employeeId={data.id} editable />
      )}
    </div>
  )
}
