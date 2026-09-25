import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save, Upload, X } from 'lucide-react'
import { ApiError, get, patch, post, upload } from '../../lib/api'
import { useToast } from '../../app/providers/ToastProvider'
import { Button, Card, Field, Input, PageHeader, Select, Spinner, Textarea } from '../../components/ui'
import {
  DepartmentSelector,
  EmployeeTypeSelector,
  DesignationSelector,
  LocationSelector,
  SupervisorSelector,
} from '../../components/forms/selectors'
import type { EmployeeDetail } from '../../types/api'

/**
 * Create and edit an employee.
 *
 * The same form serves both: on create it can also provision a login, which is
 * the only moment a temporary password is set.
 */

const schema = z.object({
  employeeCode: z
    .string()
    .trim()
    .min(2, 'An employee code is required')
    .max(24)
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, hyphen or underscore only'),
  firstName: z.string().trim().min(1, 'First name is required').max(80),
  middleName: z.string().trim().max(80).optional().or(z.literal('')),
  lastName: z.string().trim().max(80).optional().or(z.literal('')),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED']),
  dateOfBirth: z.string().optional().or(z.literal('')),
  maritalStatus: z.enum(['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'UNDISCLOSED']),
  parentName: z.string().trim().max(160).optional().or(z.literal('')),
  personalEmail: z.string().trim().email('Enter a valid email').optional().or(z.literal('')),
  workEmail: z.string().trim().email('Enter a valid email').optional().or(z.literal('')),
  mobileNumber: z.string().trim().optional().or(z.literal('')),
  departmentId: z.string().optional().or(z.literal('')),
  designationId: z.string().optional().or(z.literal('')),
  locationId: z.string().optional().or(z.literal('')),
  supervisorId: z.string().optional().or(z.literal('')),
  isSupervisor: z.boolean(),
  employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY', 'INTERN']),
  employmentStatus: z.enum(['ACTIVE', 'INACTIVE', 'ON_NOTICE', 'RESIGNED', 'TERMINATED']),
  salaryBasis: z.enum(['MONTHLY', 'DAILY']),
  employeeTypeId: z.string().uuid('Choose a supply type'),
  plant: z.enum(['ULTRATECH', 'ICL']).optional().or(z.literal('')),
  skillCategory: z.enum(['UNSKILLED', 'SEMI_SKILLED', 'SKILLED', 'HIGHLY_SKILLED']).optional().or(z.literal('')),
  duties: z.string().trim().max(1000).optional().or(z.literal('')),
  overtimeRateOverride: z.string().optional().or(z.literal('')),
  joiningDate: z.string().min(1, 'A joining date is required'),
  exitDate: z.string().optional().or(z.literal('')),
  createUserAccount: z.boolean(),
  userEmail: z.string().trim().email('Enter a valid email').optional().or(z.literal('')),
  userRole: z.enum(['SUPER_ADMIN', 'SUPERVISOR', 'EMPLOYEE']),
  temporaryPassword: z.string().optional().or(z.literal('')),
})

type FormValues = z.infer<typeof schema>

/** Strips the empty strings the form uses for "not set" back to nulls. */
function toPayload(values: FormValues, isEdit: boolean): Record<string, unknown> {
  const blank = (value: string | undefined): string | null => (value && value.trim() !== '' ? value.trim() : null)

  const base: Record<string, unknown> = {
    firstName: values.firstName,
    middleName: blank(values.middleName),
    lastName: blank(values.lastName),
    gender: values.gender,
    dateOfBirth: blank(values.dateOfBirth),
    maritalStatus: values.maritalStatus,
    parentName: blank(values.parentName),
    personalEmail: blank(values.personalEmail),
    workEmail: blank(values.workEmail),
    mobileNumber: blank(values.mobileNumber),
    departmentId: blank(values.departmentId),
    designationId: blank(values.designationId),
    locationId: blank(values.locationId),
    supervisorId: blank(values.supervisorId),
    isSupervisor: values.isSupervisor,
    employmentType: values.employmentType,
    employmentStatus: values.employmentStatus,
    salaryBasis: values.salaryBasis,
    employeeTypeId: values.employeeTypeId,
    plant: values.plant || null,
    skillCategory: values.skillCategory || null,
    duties: blank(values.duties),
    overtimeRateOverride: values.overtimeRateOverride ? Number(values.overtimeRateOverride) : null,
    joiningDate: values.joiningDate,
  }

  if (isEdit) {
    base.exitDate = blank(values.exitDate)
    return base
  }

  base.employeeCode = values.employeeCode.toUpperCase()
  base.createUserAccount = values.createUserAccount
  if (values.createUserAccount) {
    base.userEmail = blank(values.userEmail) ?? blank(values.workEmail) ?? blank(values.personalEmail)
    base.userRole = values.userRole
    base.temporaryPassword = blank(values.temporaryPassword)
  }
  return base
}

export default function EmployeeFormPage() {
  const { id } = useParams<{ id: string }>()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data: existing, isLoading } = useQuery({
    queryKey: ['employee', id],
    queryFn: () => get<EmployeeDetail>(`/employees/${id}`),
    enabled: isEdit,
  })

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    getValues,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      employeeCode: '',
      firstName: '',
      middleName: '',
      lastName: '',
      gender: 'UNDISCLOSED',
      dateOfBirth: '',
      maritalStatus: 'UNDISCLOSED',
      parentName: '',
      personalEmail: '',
      workEmail: '',
      mobileNumber: '',
      departmentId: '',
      designationId: '',
      locationId: '',
      supervisorId: '',
      isSupervisor: false,
      employmentType: 'FULL_TIME',
      employmentStatus: 'ACTIVE',
      salaryBasis: 'MONTHLY',
      employeeTypeId: '',
      plant: '',
      overtimeRateOverride: '',
      joiningDate: '',
      exitDate: '',
      createUserAccount: false,
      userEmail: '',
      userRole: 'EMPLOYEE',
      temporaryPassword: '',
    },
  })

  useEffect(() => {
    if (!existing) return
    reset({
      employeeCode: existing.employeeCode,
      firstName: existing.firstName,
      middleName: existing.middleName ?? '',
      lastName: existing.lastName ?? '',
      gender: (existing.gender as FormValues['gender']) ?? 'UNDISCLOSED',
      dateOfBirth: existing.dateOfBirth ?? '',
      maritalStatus: (existing.maritalStatus as FormValues['maritalStatus']) ?? 'UNDISCLOSED',
      parentName: existing.parentName ?? '',
      personalEmail: existing.personalEmail ?? '',
      workEmail: existing.workEmail ?? '',
      mobileNumber: existing.mobileNumber ?? '',
      departmentId: existing.departmentId ?? '',
      designationId: existing.designationId ?? '',
      locationId: existing.locationId ?? '',
      supervisorId: existing.supervisorId ?? '',
      isSupervisor: existing.isSupervisor,
      employmentType: existing.employmentType,
      employmentStatus: existing.employmentStatus,
      salaryBasis: existing.salaryBasis,
      employeeTypeId: existing.employeeTypeId,
      plant: existing.plant ?? '',
      skillCategory: (existing.skillCategory as FormValues['skillCategory']) ?? '',
      duties: existing.duties ?? '',
      overtimeRateOverride: existing.overtimeRateOverride !== null ? String(existing.overtimeRateOverride) : '',
      joiningDate: existing.joiningDate,
      exitDate: existing.exitDate ?? '',
      createUserAccount: false,
      userEmail: '',
      userRole: 'EMPLOYEE',
      temporaryPassword: '',
    })
  }, [existing, reset])

  // On a new employee, offer the next code in the series rather than a blank
  // box. It is only a suggestion and stays editable; the unique constraint is
  // what actually prevents a clash.
  const { data: suggestedCode } = useQuery({
    queryKey: ['employees', 'next-code'],
    queryFn: () => get<{ nextCode: string }>('/employees/next-code'),
    enabled: !isEdit,
    staleTime: 0,
  })

  useEffect(() => {
    if (isEdit || !suggestedCode?.nextCode) return
    // Never overwrite something already typed.
    if (getValues('employeeCode')) return
    setValue('employeeCode', suggestedCode.nextCode)
  }, [isEdit, suggestedCode, getValues, setValue])

  // The photo endpoint is /employees/:id/photo, so on a new employee there is
  // no id to post to yet. The file is held here and uploaded once the employee
  // has been created, which keeps it one action for whoever fills the form in.
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const photoInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!photoFile) {
      setPhotoPreview(null)
      return
    }
    const url = URL.createObjectURL(photoFile)
    setPhotoPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photoFile])

  function choosePhoto(file: File | null) {
    if (!file) {
      setPhotoFile(null)
      return
    }
    // Matches the employees_photo_mime_type check on the table.
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      toast.error('Choose a PNG or JPEG image')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('That photo is larger than 5 MB')
      return
    }
    setPhotoFile(file)
  }

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      isEdit
        ? patch<EmployeeDetail>(`/employees/${id}`, toPayload(values, true))
        : post<EmployeeDetail>('/employees', toPayload(values, false)),
    onSuccess: async (response) => {
      const employeeId = response.data.id ?? id
      toast.success(isEdit ? 'Employee updated' : 'Employee created')

      // A failed photo must not lose the employee that was just saved, so it is
      // reported on its own and the form still moves on.
      if (photoFile && employeeId) {
        try {
          const formData = new FormData()
          formData.append('file', photoFile)
          await upload(`/employees/${employeeId}/photo`, formData)
        } catch (photoError) {
          toast.error(
            'The employee was saved, but the photo did not upload',
            photoError instanceof Error ? photoError.message : undefined,
          )
        }
      }

      await queryClient.invalidateQueries({ queryKey: ['employees'] })
      await queryClient.invalidateQueries({ queryKey: ['employee', id] })
      navigate(`/employees/${employeeId}`)
    },
    onError: (error: Error) => {
      // Server-side field errors are folded back into the form.
      if (error instanceof ApiError) {
        const fields = error.fieldErrors
        let matched = false
        for (const [field, message] of Object.entries(fields)) {
          if (field in schema.shape) {
            setError(field as keyof FormValues, { message })
            matched = true
          }
        }
        if (!matched) toast.error('Could not save', error.message)
        return
      }
      toast.error('Could not save', error.message)
    },
  })

  const createUserAccount = watch('createUserAccount')

  if (isEdit && isLoading) return <Spinner label="Loading employee" />

  return (
    <div className="page">
      <PageHeader
        breadcrumbs={[{ label: 'Employees', to: '/employees' }, { label: isEdit ? 'Edit' : 'New employee' }]}
        title={isEdit ? `Edit ${existing?.fullName ?? 'employee'}` : 'Add an employee'}
        description={
          isEdit
            ? 'Structural changes are recorded in the employment history.'
            : 'Create the employee record, and optionally a login for them.'
        }
      />

      <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="stack" noValidate>
        <Card title="Personal information">
          <div className="grid grid-2">
            {!isEdit ? (
              <Field label="Employee code" htmlFor="employeeCode" error={errors.employeeCode?.message} required>
                <Input id="employeeCode" style={{ textTransform: 'uppercase' }} {...register('employeeCode')} />
              </Field>
            ) : (
              <Field label="Employee code" htmlFor="employeeCodeRO">
                <Input id="employeeCodeRO" value={existing?.employeeCode ?? ''} disabled />
              </Field>
            )}

            <Field label="First name" htmlFor="firstName" error={errors.firstName?.message} required>
              <Input id="firstName" {...register('firstName')} />
            </Field>

            <Field label="Middle name" htmlFor="middleName">
              <Input id="middleName" {...register('middleName')} />
            </Field>

            <Field label="Last name" htmlFor="lastName">
              <Input id="lastName" {...register('lastName')} />
            </Field>

            <Field label="Gender" htmlFor="gender">
              <Select id="gender" {...register('gender')}>
                <option value="UNDISCLOSED">Prefer not to say</option>
                <option value="FEMALE">Female</option>
                <option value="MALE">Male</option>
                <option value="OTHER">Other</option>
              </Select>
            </Field>

            <Field label="Date of birth" htmlFor="dateOfBirth" error={errors.dateOfBirth?.message}>
              <Input id="dateOfBirth" type="date" {...register('dateOfBirth')} />
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

            <Field
              label="Father's / Mother's name"
              htmlFor="parentName"
              hint="Printed on the Letter of Appointment."
            >
              <Input id="parentName" {...register('parentName')} />
            </Field>

            <Field label="Mobile number" htmlFor="mobileNumber" error={errors.mobileNumber?.message}>
              <Input id="mobileNumber" type="tel" {...register('mobileNumber')} />
            </Field>

            <Field label="Work email" htmlFor="workEmail" error={errors.workEmail?.message}>
              <Input id="workEmail" type="email" {...register('workEmail')} />
            </Field>

            <Field label="Personal email" htmlFor="personalEmail" error={errors.personalEmail?.message}>
              <Input id="personalEmail" type="email" {...register('personalEmail')} />
            </Field>
          </div>
        </Card>

        <Card title="Location & employment type" description="Where this employee works, and the categories that drive overtime and pay rules.">
          <div className="grid grid-2">
            <Field label="Location" htmlFor="locationId">
              <LocationSelector
                id="locationId"
                value={watch('locationId') ?? ''}
                onChange={(value) => setValue('locationId', value)}
                includeAll={false}
              />
            </Field>

            <Field
              label="Supply type"
              htmlFor="employeeTypeId"
              hint="The type decides whether overtime becomes extra weekly offs or is paid per hour. Manage the list under Organization."
              error={errors.employeeTypeId?.message}
              required
            >
              <EmployeeTypeSelector
                id="employeeTypeId"
                includeAll={false}
                value={watch('employeeTypeId') ?? ''}
                onChange={(next) => setValue('employeeTypeId', next, { shouldValidate: true, shouldDirty: true })}
              />
            </Field>

            <Field label="Plant" htmlFor="plant">
              <Select id="plant" {...register('plant')}>
                <option value="">Not set</option>
                <option value="ULTRATECH">Ultratech</option>
                <option value="ICL">ICL</option>
              </Select>
            </Field>

            <Field
              label="Overtime rate override"
              htmlFor="overtimeRateOverride"
              hint="PSR only: rupees per overtime hour for this employee. Leave blank to use the organization's default rate."
            >
              <Input id="overtimeRateOverride" type="number" step="0.01" min="0" {...register('overtimeRateOverride')} />
            </Field>

            <Field
              label="Category of skill"
              htmlFor="skillCategory"
              hint="Printed on the Letter of Appointment."
            >
              <Select id="skillCategory" {...register('skillCategory')}>
                <option value="">Not set</option>
                <option value="UNSKILLED">Unskilled</option>
                <option value="SEMI_SKILLED">Semi skilled</option>
                <option value="SKILLED">Skilled</option>
                <option value="HIGHLY_SKILLED">Highly skilled</option>
              </Select>
            </Field>
          </div>

          <Field
            label="Broad nature of duties"
            htmlFor="duties"
            hint="Printed on the Letter of Appointment as the duties to be performed."
          >
            <Textarea id="duties" rows={3} maxLength={1000} {...register('duties')} />
          </Field>
        </Card>

        <Card title="Employment">
          <div className="grid grid-2">
            <Field label="Department" htmlFor="departmentId">
              <DepartmentSelector
                id="departmentId"
                value={watch('departmentId') ?? ''}
                onChange={(value) => setValue('departmentId', value)}
                includeAll={false}
              />
            </Field>

            <Field label="Section" htmlFor="designationId">
              <DesignationSelector
                id="designationId"
                value={watch('designationId') ?? ''}
                onChange={(value) => setValue('designationId', value)}
                includeAll={false}
              />
            </Field>

            <Field label="Supervisor" htmlFor="supervisorId">
              <SupervisorSelector
                id="supervisorId"
                value={watch('supervisorId') ?? ''}
                onChange={(value) => setValue('supervisorId', value)}
                includeAll={false}
              />
            </Field>

            <Field label="Employment type" htmlFor="employmentType">
              <Select id="employmentType" {...register('employmentType')}>
                <option value="FULL_TIME">Full time</option>
                <option value="PART_TIME">Part time</option>
                <option value="CONTRACT">Contract</option>
                <option value="TEMPORARY">Temporary</option>
                <option value="INTERN">Intern</option>
              </Select>
            </Field>

            <Field label="Employment status" htmlFor="employmentStatus">
              <Select id="employmentStatus" {...register('employmentStatus')}>
                <option value="ACTIVE">Active</option>
                <option value="ON_NOTICE">On notice</option>
                <option value="RESIGNED">Resigned</option>
                <option value="TERMINATED">Terminated</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            </Field>

            <Field
              label="Salary basis"
              htmlFor="salaryBasis"
              hint="Daily-paid employees are paid per paid day rather than a monthly amount."
            >
              <Select id="salaryBasis" {...register('salaryBasis')}>
                <option value="MONTHLY">Monthly</option>
                <option value="DAILY">Daily</option>
              </Select>
            </Field>

            <Field label="Joining date" htmlFor="joiningDate" error={errors.joiningDate?.message} required>
              <Input id="joiningDate" type="date" {...register('joiningDate')} />
            </Field>

            {isEdit ? (
              <Field label="Exit date" htmlFor="exitDate" hint="Set this when the employee leaves.">
                <Input id="exitDate" type="date" {...register('exitDate')} />
              </Field>
            ) : null}

            <Field label="Is a supervisor" htmlFor="isSupervisor" hint="Supervisors can be assigned a team.">
              <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                <input id="isSupervisor" type="checkbox" {...register('isSupervisor')} />
                <span>This employee supervises others</span>
              </label>
            </Field>
          </div>
        </Card>

        <Card
          title="Photo"
          description={
            isEdit
              ? 'Replacing the photo here takes effect when you save.'
              : 'Optional. Uploaded as soon as the employee is created.'
          }
        >
          <div className="row" style={{ gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {photoPreview ? (
              <img
                src={photoPreview}
                alt="Selected employee photo"
                style={{
                  width: 96,
                  height: 96,
                  objectFit: 'cover',
                  borderRadius: '50%',
                  border: '1px solid var(--border)',
                }}
              />
            ) : (
              <div
                aria-hidden="true"
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: '50%',
                  border: '1px dashed var(--border)',
                  display: 'grid',
                  placeItems: 'center',
                  color: 'var(--muted)',
                }}
              >
                <Upload size={20} />
              </div>
            )}

            <div className="stack" style={{ gap: '0.5rem' }}>
              <input
                ref={photoInputRef}
                id="employeePhoto"
                type="file"
                accept="image/png,image/jpeg"
                style={{ display: 'none' }}
                onChange={(event) => {
                  choosePhoto(event.target.files?.[0] ?? null)
                  // Clear the input so re-picking the same file still fires onChange.
                  event.target.value = ''
                }}
              />
              <div className="row" style={{ gap: '0.5rem' }}>
                <Button type="button" variant="secondary" onClick={() => photoInputRef.current?.click()}>
                  <Upload size={16} /> {photoFile ? 'Choose another' : 'Choose a photo'}
                </Button>
                {photoFile ? (
                  <Button type="button" variant="secondary" onClick={() => choosePhoto(null)}>
                    <X size={16} /> Remove
                  </Button>
                ) : null}
              </div>
              <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
                {photoFile ? photoFile.name : 'PNG or JPEG, up to 5 MB.'}
              </p>
            </div>
          </div>
        </Card>

        {!isEdit ? (
          <Card title="Login" description="Optional. The employee can sign in and manage their own documents.">
            <div className="grid grid-2">
              <Field label="Create a login" htmlFor="createUserAccount">
                <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <input id="createUserAccount" type="checkbox" {...register('createUserAccount')} />
                  <span>Create a user account</span>
                </label>
              </Field>

              {createUserAccount ? (
                <>
                  <Field
                    label="Login email"
                    htmlFor="userEmail"
                    error={errors.userEmail?.message}
                    hint="Defaults to the work email address."
                  >
                    <Input id="userEmail" type="email" {...register('userEmail')} />
                  </Field>

                  <Field label="Role" htmlFor="userRole">
                    <Select id="userRole" {...register('userRole')}>
                      <option value="EMPLOYEE">Employee</option>
                      <option value="SUPERVISOR">Supervisor</option>
                      <option value="SUPER_ADMIN">Super Admin</option>
                    </Select>
                  </Field>

                  <Field
                    label="Temporary password"
                    htmlFor="temporaryPassword"
                    hint="Leave blank to generate one. The employee must change it at first sign-in."
                  >
                    <Input id="temporaryPassword" type="text" {...register('temporaryPassword')} />
                  </Field>
                </>
              ) : null}
            </div>
          </Card>
        ) : null}

        <div className="row">
          <Button type="submit" loading={isSubmitting || mutation.isPending} icon={<Save size={15} />}>
            {isEdit ? 'Save changes' : 'Create employee'}
          </Button>
          <Button variant="secondary" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}
