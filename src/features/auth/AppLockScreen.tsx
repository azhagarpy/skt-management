import { useEffect, useRef, useState } from 'react'
import { Lock, LogOut } from 'lucide-react'
import { useAuth } from '../../app/providers/AuthProvider'
import { ApiError } from '../../lib/api'
import { Avatar, Button } from '../../components/ui'

const PIN_LENGTH = 4

/**
 * The app lock.
 *
 * Shown in place of the whole app when the session was restored on a device
 * where the user is still signed in but has not entered their PIN on this page
 * yet. The server refuses every other request until the PIN is accepted, so
 * this screen is the only way in short of signing in again with the password.
 */
export default function AppLockScreen() {
  const { user, unlock, logout } = useAuth()
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (value: string): Promise<void> => {
    if (value.length !== PIN_LENGTH || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await unlock(value)
    } catch (unlockError) {
      // A lockout signs the session out and the sign-in page takes over.
      setError(unlockError instanceof ApiError ? unlockError.message : 'Could not check the PIN right now')
      setPin('')
      setSubmitting(false)
      inputRef.current?.focus()
    }
  }

  return (
    <div className="auth-page auth-page-narrow">
      <div className="auth-panel app-lock">
        <div className="app-lock-head">
          <Avatar name={user?.fullName ?? '?'} size={56} />
          <p className="app-lock-name">{user?.fullName}</p>
          <p className="auth-subtitle">{user?.email}</p>
        </div>

        <h1 className="auth-title app-lock-title">
          <Lock size={18} aria-hidden /> Enter your PIN
        </h1>
        <p className="auth-subtitle">This site is locked. Enter your 4-digit PIN to continue.</p>

        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit(pin)
          }}
          noValidate
        >
          {error ? (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          ) : null}

          <label htmlFor="app-lock-pin" className="sr-only">
            PIN
          </label>
          <div className="pin-field" onClick={() => inputRef.current?.focus()}>
            <input
              ref={inputRef}
              id="app-lock-pin"
              className="pin-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={PIN_LENGTH}
              value={pin}
              disabled={submitting}
              aria-describedby="app-lock-help"
              onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH)
                setPin(digits)
                if (digits.length === PIN_LENGTH) void submit(digits)
              }}
            />
            <div className="pin-dots" aria-hidden>
              {Array.from({ length: PIN_LENGTH }, (_, index) => (
                <span key={index} className={`pin-dot${index < pin.length ? ' pin-dot-filled' : ''}`} />
              ))}
            </div>
          </div>
          <p id="app-lock-help" className="auth-links">
            It unlocks on the fourth digit.
          </p>

          <Button type="submit" block loading={submitting} disabled={pin.length !== PIN_LENGTH}>
            Unlock
          </Button>
        </form>

        <p className="auth-links">
          Forgot your PIN or not you?{' '}
          <button type="button" className="link-button" onClick={() => void logout()}>
            <LogOut size={13} aria-hidden /> Sign out
          </button>{' '}
          and sign in with the password.
        </p>
      </div>
    </div>
  )
}
