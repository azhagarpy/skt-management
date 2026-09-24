import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '../../components/ui'
import { useAuth } from '../providers/AuthProvider'
import { tourScript, type TourStep } from './tour-steps'

/**
 * First-run product tour.
 *
 * Spotlights one module at a time and says what it is for. Steps whose target
 * is not on screen are dropped before the tour starts, so the script matches
 * whatever this particular user can actually reach.
 */

const STORAGE_PREFIX = 'sktransport.tour.v1'
const CARD_WIDTH = 340
const GAP = 14

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}.${userId}`
}

export function hasSeenTour(userId: string): boolean {
  try {
    return window.localStorage.getItem(storageKey(userId)) === 'done'
  } catch {
    // Private mode or blocked site data: treat as seen so the tour is not
    // forced on every single load.
    return true
  }
}

function markSeen(userId: string): void {
  try {
    window.localStorage.setItem(storageKey(userId), 'done')
  } catch {
    /* nothing to do - the tour simply reappears next time */
  }
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

function readRect(selector: string | undefined): Rect | null {
  if (!selector) return null
  const element = document.querySelector(selector)
  if (!(element instanceof HTMLElement)) return null
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  // Below 1024px the sidebar is translated off-screen rather than hidden, so it
  // still reports a box. Anything outside the viewport gets a centred card
  // instead of a spotlight pointing at nothing.
  if (rect.right <= 0 || rect.left >= window.innerWidth) return null
  if (rect.bottom <= 0 || rect.top >= window.innerHeight) return null
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

export function ProductTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth()
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // Resolve the script once per opening, keeping only steps we can point at.
  const steps = useMemo<TourStep[]>(() => {
    if (!open || !user) return []
    return tourScript(user.role).filter((step) => !step.target || readRect(step.target) !== null)
  }, [open, user])

  const step = steps[index]
  const isLast = index === steps.length - 1

  useEffect(() => {
    if (open) setIndex(0)
  }, [open])

  const finish = useCallback(() => {
    if (user) markSeen(user.id)
    onClose()
  }, [user, onClose])

  // Track the target box, and follow it if the layout moves.
  useLayoutEffect(() => {
    if (!open || !step) return
    const update = (): void => setRect(readRect(step.target))
    update()

    const element = step.target ? document.querySelector(step.target) : null
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, step])

  useEffect(() => {
    if (open) cardRef.current?.focus()
  }, [open, index])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish()
      if (event.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, steps.length - 1))
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, steps.length, finish])

  if (!open || !step) return null

  // Prefer the right of the target; fall back to below, then centre.
  const cardStyle: React.CSSProperties = (() => {
    if (!rect) {
      return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: CARD_WIDTH }
    }
    const roomRight = window.innerWidth - (rect.left + rect.width)
    if (roomRight > CARD_WIDTH + GAP * 2) {
      const top = Math.min(Math.max(GAP, rect.top - 8), Math.max(GAP, window.innerHeight - 240))
      return { top, left: rect.left + rect.width + GAP, width: CARD_WIDTH }
    }
    const below = rect.top + rect.height + GAP
    const fitsBelow = below + 220 < window.innerHeight
    return {
      top: fitsBelow ? below : Math.max(GAP, rect.top - 220 - GAP),
      left: Math.min(Math.max(GAP, rect.left), Math.max(GAP, window.innerWidth - CARD_WIDTH - GAP)),
      width: Math.min(CARD_WIDTH, window.innerWidth - GAP * 2),
    }
  })()

  return createPortal(
    <div className="tour-root" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {rect ? (
        <div
          className="tour-spotlight"
          style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      ) : (
        <div className="tour-scrim" />
      )}

      <div className="tour-card" style={cardStyle} ref={cardRef} tabIndex={-1}>
        <button type="button" className="tour-close" onClick={finish} aria-label="Close tour">
          <X size={16} />
        </button>

        <p className="tour-progress">
          Step {index + 1} of {steps.length}
        </p>
        <h2 className="tour-title" id="tour-title">
          {step.title}
        </h2>
        <p className="tour-body">{step.body}</p>

        <div className="tour-actions">
          <button type="button" className="tour-skip" onClick={finish}>
            {isLast ? 'Close' : 'Skip tour'}
          </button>
          <div className="tour-nav">
            {index > 0 ? (
              <Button size="sm" variant="secondary" onClick={() => setIndex((i) => i - 1)}>
                Back
              </Button>
            ) : null}
            {isLast ? (
              <Button size="sm" onClick={finish}>
                Get started
              </Button>
            ) : (
              <Button size="sm" onClick={() => setIndex((i) => i + 1)}>
                Next
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
