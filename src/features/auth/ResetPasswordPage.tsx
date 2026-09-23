import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ApiError, post } from '../../lib/api'
import { Button, Field, Input } from '../../components/ui'
import { PasswordStrengthHint, passwordSchema } from './password-rules'

const schema = z
  .object({
    token: z.string().min(10, 'The reset token is missing or invalid'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The passwords do not match',
  })

type FormValues = z.infer<typeof schema>

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { token: searchParams.get('token') ?? '', password: '', confirmPassword: '' },
  })

  const password = watch('password')

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      await post('/auth/reset-password', { token: values.token, password: values.password })
      navigate('/login', { replace: true })
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Unable to reset the password')
    }
  })

  return (
    <div className="auth-page auth-page-narrow">
      <div className="auth-panel">
        <h1 className="auth-title">Choose a new password</h1>

        <form onSubmit={onSubmit} className="auth-form" noValidate>
          {formError ? (
            <div className="alert alert-error" role="alert">
              {formError}
            </div>
          ) : null}

          <Field label="Reset token" htmlFor="token" error={errors.token?.message} required>
            <Input id="token" {...register('token')} />
          </Field>

          <Field label="New password" htmlFor="password" error={errors.password?.message} required>
            <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
          </Field>

          <PasswordStrengthHint password={password} />

          <Field label="Confirm password" htmlFor="confirmPassword" error={errors.confirmPassword?.message} required>
            <Input id="confirmPassword" type="password" autoComplete="new-password" {...register('confirmPassword')} />
          </Field>

          <Button type="submit" loading={isSubmitting} block>
            Reset password
          </Button>

          <p className="auth-links">
            <Link to="/login">Back to sign in</Link>
          </p>
        </form>
      </div>
    </div>
  )
}
