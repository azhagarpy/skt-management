import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, Search, X } from 'lucide-react'

/**
 * The shared UI kit.
 *
 * Every screen builds from these primitives so the application looks and behaves
 * as one product, and so accessibility (labels, focus, keyboard handling) is
 * handled once rather than per page.
 */

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, icon, block = false, children, className = '', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      className={`btn btn-${variant} btn-${size}${block ? ' btn-block' : ''} ${className}`.trim()}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="spin" size={16} aria-hidden /> : icon}
      {children ? <span>{children}</span> : null}
    </button>
  )
})

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({
  title,
  description,
  actions,
  children,
  className = '',
  padded = true,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <section className={`card ${className}`.trim()}>
      {title || actions ? (
        <header className="card-header">
          <div>
            {typeof title === 'string' ? <h2 className="card-title">{title}</h2> : title}
            {description ? <p className="card-description">{description}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={padded ? 'card-body' : 'card-body card-body-flush'}>{children}</div>
    </section>
  )
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: string
  description?: string
  actions?: ReactNode
  breadcrumbs?: { label: string; to?: string }[]
}) {
  return (
    <header className="page-header">
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          {breadcrumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`}>
              {index > 0 ? <span className="breadcrumb-separator">/</span> : null}
              {crumb.to ? (
                <a href={crumb.to} className="breadcrumb-link">
                  {crumb.label}
                </a>
              ) : (
                <span>{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="page-header-row">
        <div>
          <h1 className="page-title">{title}</h1>
          {description ? <p className="page-description">{description}</p> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export function Field({
  label,
  error,
  hint,
  required,
  children,
  htmlFor,
}: {
  label: string
  error?: string
  hint?: string
  required?: boolean
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <div className={`field${error ? ' field-error' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="field-required" aria-hidden> *</span> : null}
      </label>
      {children}
      {error ? (
        <p className="field-message field-message-error" role="alert">
          <AlertCircle size={12} aria-hidden /> {error}
        </p>
      ) : hint ? (
        <p className="field-message">{hint}</p>
      ) : null}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = '', ...rest },
  ref,
) {
  return <input ref={ref} className={`input ${className}`.trim()} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className = '', rows = 3, ...rest },
  ref,
) {
  return <textarea ref={ref} rows={rows} className={`input textarea ${className}`.trim()} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = '', children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={`input select ${className}`.trim()} {...rest}>
      {children}
    </select>
  )
})

/**
 * A currency input that keeps the raw number in form state while showing a
 * grouped value, so users can type freely and still submit a clean number.
 */
export const CurrencyInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function CurrencyInput({ className = '', ...rest }, ref) {
    return (
      <div className="currency-input">
        <span className="currency-symbol" aria-hidden>
          ₹
        </span>
        <input
          ref={ref}
          type="number"
          step="0.01"
          min="0"
          inputMode="decimal"
          className={`input ${className}`.trim()}
          {...rest}
        />
      </div>
    )
  },
)

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  ariaLabel = 'Search',
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
}) {
  const id = useId()
  return (
    <div className="search-input">
      <Search size={15} aria-hidden />
      <input
        id={id}
        className="input"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button type="button" className="search-clear" onClick={() => onChange('')} aria-label="Clear search">
          <X size={14} />
        </button>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Status and feedback
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

/** Maps the domain statuses onto a consistent colour language. */
const STATUS_TONES: Record<string, BadgeTone> = {
  // Attendance
  PRESENT: 'success',
  ABSENT: 'danger',
  ON_LEAVE: 'warning',
  HALF_DAY_LEAVE: 'info',
  HOLIDAY: 'accent',
  WEEKLY_OFF: 'neutral',
  // Verification
  VERIFIED: 'success',
  PENDING: 'warning',
  REJECTED: 'danger',
  MISSING: 'neutral',
  // Employment
  ACTIVE: 'success',
  INACTIVE: 'neutral',
  ON_NOTICE: 'warning',
  RESIGNED: 'neutral',
  TERMINATED: 'danger',
  // Leave
  APPROVED: 'success',
  CANCELLED: 'neutral',
  // Payroll
  DRAFT: 'neutral',
  CALCULATED: 'info',
  UNDER_REVIEW: 'warning',
  LOCKED: 'accent',
  // Payment
  PARTIALLY_PAID: 'warning',
  PAID: 'success',
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="muted">—</span>
  const tone = STATUS_TONES[status] ?? 'neutral'
  const label = status
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
  return <Badge tone={tone}>{label}</Badge>
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <Loader2 className="spin" size={20} aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state-icon">{icon}</div> : null}
      <p className="empty-state-title">{title}</p>
      {description ? <p className="empty-state-description">{description}</p> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong'
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={18} aria-hidden />
      <div>
        <p className="error-state-title">{message}</p>
        {onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Callers pass onClose as an inline arrow function, so its identity changes on
  // every render (e.g. every keystroke in the form). Reading it through a ref keeps
  // the effect below from depending on it directly - otherwise the effect re-runs on
  // every keystroke and dialogRef.current.focus() steals focus back from whatever
  // input the user is typing into, right after each character.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // Escape closes, and focus moves into the dialog when it opens. Depends only on
  // `open` so this runs once per open/close transition, not on every render.
  useEffect(() => {
    if (!open) return undefined

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open) return null

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className={`modal modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <h2 className="modal-title">{title}</h2>
            {description ? <p className="modal-description">{description}</p> : null}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  loading = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'primary' | 'danger'
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="confirm-message">{message}</div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
}: {
  page: number
  pageSize: number
  total: number
  totalPages: number
  onPageChange: (page: number) => void
}) {
  if (total === 0) return null

  const from = (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  return (
    <div className="pagination">
      <p className="pagination-summary">
        Showing <strong>{from}</strong>–<strong>{to}</strong> of <strong>{total}</strong>
      </p>
      <div className="pagination-controls">
        <Button
          variant="secondary"
          size="sm"
          icon={<ChevronLeft size={14} />}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <span className="pagination-page">
          Page {page} of {Math.max(totalPages, 1)}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next <ChevronRight size={14} />
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function ProgressBar({ value, tone = 'accent' }: { value: number; tone?: BadgeTone }) {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div className="progress" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
      <div className={`progress-fill progress-${tone}`} style={{ width: `${clamped}%` }} />
    </div>
  )
}

export function Avatar({ name, size = 36, src }: { name: string; size?: number; src?: string | null }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase()

  if (src) {
    return (
      <img
        className="avatar"
        src={src}
        alt={name}
        style={{ width: size, height: size, objectFit: 'cover' }}
      />
    )
  }

  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {initials || '?'}
    </span>
  )
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string; count?: number }[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          className={`tab${active === tab.key ? ' tab-active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function StatTile({
  label,
  value,
  sublabel,
  tone = 'neutral',
  icon,
}: {
  label: string
  value: ReactNode
  sublabel?: ReactNode
  tone?: BadgeTone
  icon?: ReactNode
}) {
  return (
    <div className={`stat-tile stat-${tone}`}>
      {icon ? <div className="stat-icon">{icon}</div> : null}
      <div className="stat-content">
        <p className="stat-label">{label}</p>
        <p className="stat-value">{value}</p>
        {sublabel ? <p className="stat-sublabel">{sublabel}</p> : null}
      </div>
    </div>
  )
}
