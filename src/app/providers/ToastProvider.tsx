import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'

/** Lightweight toasts, so every mutation can confirm or explain itself. */

export type ToastTone = 'success' | 'error' | 'info' | 'warning'

interface Toast {
  id: number
  tone: ToastTone
  title: string
  description?: string
}

interface ToastContextValue {
  notify: (tone: ToastTone, title: string, description?: string) => void
  success: (title: string, description?: string) => void
  error: (title: string, description?: string) => void
  info: (title: string, description?: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const ICONS: Record<ToastTone, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback(
    (tone: ToastTone, title: string, description?: string) => {
      const id = nextId.current
      nextId.current += 1
      setToasts((current) => [...current, { id, tone, title, description }])
      // Errors linger a little longer, since they usually need reading.
      window.setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4500)
    },
    [dismiss],
  )

  const value = useMemo<ToastContextValue>(
    () => ({
      notify,
      success: (title, description) => notify('success', title, description),
      error: (title, description) => notify('error', title, description),
      info: (title, description) => notify('info', title, description),
    }),
    [notify],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.tone]
          return (
            <div key={toast.id} className={`toast toast-${toast.tone}`}>
              <Icon size={18} aria-hidden />
              <div className="toast-body">
                <p className="toast-title">{toast.title}</p>
                {toast.description ? <p className="toast-description">{toast.description}</p> : null}
              </div>
              <button type="button" className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside a ToastProvider')
  return context
}
