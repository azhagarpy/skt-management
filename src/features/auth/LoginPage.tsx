import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { LogIn } from 'lucide-react'
import { useAuth } from '../../app/providers/AuthProvider'
import { ApiError } from '../../lib/api'
import { Button, Field, Input } from '../../components/ui'

const schema = z.object({
  identifier: z.string().trim().min(1, 'Enter your email or employee ID'),
  password: z.string().min(1, 'Enter your password'),
})

type FormValues = z.infer<typeof schema>

/** Sign-in accepts either an email address or an employee ID (plan section 37). */
export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { identifier: '', password: '' } })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      const user = await login(values.identifier, values.password)
      const from = (location.state as { from?: string } | null)?.from
      navigate(user.mustChangePassword ? '/change-password' : (from ?? '/'), { replace: true })
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Unable to sign in right now')
    }
  })

  return (
    <div className="auth-page">
      <div className="auth-panel">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden>
            NS
          </span>
          <div>
            <p className="auth-brand-name">SKTRANSPORT</p>
            <p className="auth-brand-tagline">People and payroll operations</p>
          </div>
        </div>

        <h1 className="auth-title">Sign in</h1>
        <p className="auth-subtitle">Use your work email address or your employee ID.</p>

        <form onSubmit={onSubmit} className="auth-form" noValidate>
          {formError ? (
            <div className="alert alert-error" role="alert">
              {formError}
            </div>
          ) : null}

          <Field label="Email or employee ID" htmlFor="identifier" error={errors.identifier?.message} required>
            <Input
              id="identifier"
              autoComplete="username"
              autoFocus
              placeholder="you@company.com"
              {...register('identifier')}
            />
          </Field>

          <Field label="Password" htmlFor="password" error={errors.password?.message} required>
            <Input id="password" type="password" autoComplete="current-password" {...register('password')} />
          </Field>

          <Button type="submit" loading={isSubmitting} block icon={<LogIn size={16} />}>
            Sign in
          </Button>

          <p className="auth-links">
            <Link to="/forgot-password">Forgot your password?</Link>
          </p>
        </form>
      </div>

      <aside className="auth-aside" aria-hidden>
        <div className="auth-aside-content">
          <h2>Everything your people operations need</h2>
          <ul>
            <li>Status-based attendance with configurable weekly offs and holidays</li>
            <li>Leave requests that keep attendance and balances consistent</li>
            <li>Deterministic payroll with a full historical snapshot</li>
            <li>Partial payments, payslips and exportable reports</li>
          </ul>
        </div>
      </aside>
    </div>
  )
}
