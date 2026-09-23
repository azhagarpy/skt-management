import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { post } from '../../lib/api'
import { Button, Field, Input } from '../../components/ui'

const schema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
})

type FormValues = z.infer<typeof schema>

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false)
  // Outside production the API returns the token so the flow can be exercised
  // without an email provider.
  const [devToken, setDevToken] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: '' } })

  const onSubmit = handleSubmit(async (values) => {
    const response = await post<{ resetToken?: string }>('/auth/forgot-password', values)
    setDevToken(response.data?.resetToken ?? null)
    setSent(true)
  })

  return (
    <div className="auth-page auth-page-narrow">
      <div className="auth-panel">
        <h1 className="auth-title">Reset your password</h1>

        {sent ? (
          <>
            <p className="auth-subtitle">
              If an account exists for that address, a password reset link has been sent. The link expires shortly.
            </p>
            {devToken ? (
              <div className="alert alert-info">
                <p>
                  <strong>Development only.</strong> Use this token on the reset screen:
                </p>
                <code className="token-block">{devToken}</code>
                <Link className="auth-links" to={`/reset-password?token=${encodeURIComponent(devToken)}`}>
                  Continue to reset
                </Link>
              </div>
            ) : null}
            <p className="auth-links">
              <Link to="/login">Back to sign in</Link>
            </p>
          </>
        ) : (
          <form onSubmit={onSubmit} className="auth-form" noValidate>
            <p className="auth-subtitle">Enter your work email address and we will send you a reset link.</p>

            <Field label="Email address" htmlFor="email" error={errors.email?.message} required>
              <Input id="email" type="email" autoComplete="email" autoFocus {...register('email')} />
            </Field>

            <Button type="submit" loading={isSubmitting} block>
              Send reset link
            </Button>

            <p className="auth-links">
              <Link to="/login">Back to sign in</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
