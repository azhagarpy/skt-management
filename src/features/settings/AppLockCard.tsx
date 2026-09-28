import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import { post, put } from '../../lib/api'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Badge, Button, Card, Field, Input } from '../../components/ui'

type Mode = 'idle' | 'set' | 'remove'

const onlyDigits = (value: string): string => value.replace(/\D/g, '').slice(0, 4)

/**
 * App lock PIN.
 *
 * With a PIN set, every time the site is opened on a device where the user is
 * still signed in - a new tab, a reload, the browser reopened - it asks for the
 * PIN before showing anything. Signing in with the password never asks for it.
 * The account password is required to set, change or remove the PIN.
 */
export function AppLockCard() {
  const { user, can, refreshUser } = useAuth()
  const toast = useToast()
  const [mode, setMode] = useState<Mode>('idle')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const enabled = user?.appPinEnabled ?? false
  const canManage = can('applock.manage')

  const reset = (): void => {
    setMode('idle')
    setPin('')
    setConfirmPin('')
    setPassword('')
    setFormError(null)
  }

  const save = useMutation({
    mutationFn: () => put('/auth/pin', { pin, currentPassword: password }),
    onSuccess: async () => {
      toast.success(enabled ? 'PIN changed' : 'App lock turned on', 'The PIN will be asked for each time the site is opened.')
      reset()
      await refreshUser()
    },
    onError: (error: Error) => setFormError(error.message),
  })

  const remove = useMutation({
    mutationFn: () => post('/auth/pin/remove', { currentPassword: password }),
    onSuccess: async () => {
      toast.success('App lock turned off')
      reset()
      await refreshUser()
    },
    onError: (error: Error) => setFormError(error.message),
  })

  // Someone without the permission only ever sees this to turn an old PIN off.
  if (!canManage && !enabled) return null

  return (
    <Card
      title="App lock PIN"
      description="Ask for a 4-digit PIN every time this site is opened while you are still signed in, so nobody else can use it on an unattended computer."
    >
      <div className="stack">
        <div className="breakdown-row">
          <span className="muted">Status</span>
          <span>
            {enabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}
          </span>
        </div>

        {mode === 'idle' ? (
          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            {canManage ? (
              <Button size="sm" icon={<Lock size={14} />} onClick={() => setMode('set')}>
                {enabled ? 'Change PIN' : 'Turn on'}
              </Button>
            ) : null}
            {enabled ? (
              <Button size="sm" variant="secondary" onClick={() => setMode('remove')}>
                Turn off
              </Button>
            ) : null}
          </div>
        ) : (
          <form
            className="stack"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              setFormError(null)
              if (mode === 'set') {
                if (pin.length !== 4) return setFormError('The PIN must be exactly 4 digits.')
                if (pin !== confirmPin) return setFormError('The two PINs do not match.')
              }
              if (!password) return setFormError('Enter your password to confirm.')
              if (mode === 'set') save.mutate()
              else remove.mutate()
            }}
          >
            {formError ? (
              <div className="alert alert-error" role="alert">
                {formError}
              </div>
            ) : null}

            {mode === 'set' ? (
              <div className="grid grid-2">
                <Field label={enabled ? 'New PIN' : 'PIN'} htmlFor="app-pin" hint="4 digits" required>
                  <Input
                    id="app-pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    maxLength={4}
                    value={pin}
                    onChange={(event) => setPin(onlyDigits(event.target.value))}
                    autoFocus
                  />
                </Field>
                <Field label="Confirm PIN" htmlFor="app-pin-confirm" required>
                  <Input
                    id="app-pin-confirm"
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    maxLength={4}
                    value={confirmPin}
                    onChange={(event) => setConfirmPin(onlyDigits(event.target.value))}
                  />
                </Field>
              </div>
            ) : (
              <p className="muted">The site will stop asking for a PIN when it is opened.</p>
            )}

            <Field
              label="Your password"
              htmlFor="app-pin-password"
              hint="Needed so nobody at an unlocked screen can change the lock."
              required
            >
              <Input
                id="app-pin-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoFocus={mode === 'remove'}
              />
            </Field>

            <div className="row" style={{ gap: '0.5rem' }}>
              <Button
                type="submit"
                size="sm"
                variant={mode === 'remove' ? 'danger' : 'primary'}
                loading={save.isPending || remove.isPending}
              >
                {mode === 'remove' ? 'Turn off' : enabled ? 'Save new PIN' : 'Turn on'}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={reset}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        <p className="subtle">
          Signing in with your password never asks for the PIN. Five wrong PINs in a row sign this device out, and
          then the password is needed. {enabled ? 'Use “Lock now” in the account menu when you step away.' : ''}
        </p>
      </div>
    </Card>
  )
}
