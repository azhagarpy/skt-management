import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../app/providers/AuthProvider'
import { ApiError, post } from '../../lib/api'
import { Button, Card, Field, Input, PageHeader } from '../../components/ui'
import { PasswordStrengthHint, passwordSchema } from './password-rules'

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The passwords do not match',
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from your current one',
  })

type FormValues = z.infer<typeof schema>

export default function ChangePasswordPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  })

  const newPassword = watch('newPassword')

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      await post('/auth/change-password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      })
      // Changing the password revokes every session, so sign back in.
      await logout()
      queryClient.clear()
      navigate('/login', { replace: true })
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Unable to change the password')
    }
  })

  return (
    <div className="page">
      <PageHeader
        title="Change password"
        description={
          user?.mustChangePassword
            ? 'Your account requires a new password before you can continue.'
            : 'Choose a new password for your account.'
        }
      />

      <Card className="narrow-card">
        <form onSubmit={onSubmit} className="stack" noValidate>
          {formError ? (
            <div className="alert alert-error" role="alert">
              {formError}
            </div>
          ) : null}

          <Field label="Current password" htmlFor="currentPassword" error={errors.currentPassword?.message} required>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              {...register('currentPassword')}
            />
          </Field>

          <Field label="New password" htmlFor="newPassword" error={errors.newPassword?.message} required>
            <Input id="newPassword" type="password" autoComplete="new-password" {...register('newPassword')} />
          </Field>

          <PasswordStrengthHint password={newPassword} />

          <Field label="Confirm new password" htmlFor="confirmPassword" error={errors.confirmPassword?.message} required>
            <Input id="confirmPassword" type="password" autoComplete="new-password" {...register('confirmPassword')} />
          </Field>

          <p className="field-message">
            You will be signed out of every device after changing your password.
          </p>

          <Button type="submit" loading={isSubmitting}>
            Change password
          </Button>
        </form>
      </Card>
    </div>
  )
}
