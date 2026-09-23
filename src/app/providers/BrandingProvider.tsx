import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchBlob, get } from '../../lib/api'
import { useAuth } from './AuthProvider'
import type { OrganizationProfile } from '../../types/api'

/**
 * Branding (organization name, logo and accent colour).
 *
 * The product takes its identity from the organization row rather than from
 * constants, so a super admin rebrands it from the Organization screen without
 * a deploy. The accent colour is stored as a single hex; the full ramp the
 * stylesheet expects is derived from it here, which is why no screen ever needs
 * to know more than one colour.
 */

/** Matches the `--brand-*` defaults in styles.css. */
export const DEFAULT_THEME_COLOR = '#5b54d6'

export const THEME_PRESETS: { label: string; value: string }[] = [
  { label: 'Indigo', value: '#5b54d6' },
  { label: 'Violet', value: '#7c4ddb' },
  { label: 'Blue', value: '#2f6fb0' },
  { label: 'Teal', value: '#159c8f' },
  { label: 'Green', value: '#2f8a52' },
  { label: 'Amber', value: '#b8862f' },
  { label: 'Rose', value: '#c2455f' },
  { label: 'Slate', value: '#4a5568' },
]

interface BrandingContextValue {
  /** The organization's name, or a neutral fallback before it has loaded. */
  name: string
  /** Up to two letters, shown when there is no logo. */
  initials: string
  themeColor: string
  /** An object URL for the logo, or null when none is set. */
  logoUrl: string | null
  isLoading: boolean
}

const BrandingContext = createContext<BrandingContextValue | null>(null)

const FALLBACK_NAME = 'Workspace'

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const int = Number.parseInt(match[1], 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((channel) => clampChannel(channel).toString(16).padStart(2, '0')).join('')}`
}

/** Mixes `colour` with `target`; weight is how much of `colour` survives. */
function mix(colour: [number, number, number], target: [number, number, number], weight: number): string {
  return toHex([
    colour[0] * weight + target[0] * (1 - weight),
    colour[1] * weight + target[1] * (1 - weight),
    colour[2] * weight + target[2] * (1 - weight),
  ])
}

const SHADE = [5, 6, 15] as const
const TINT = [255, 255, 255] as const

/**
 * Builds the six `--brand-*` stops from one hex, matching the spacing of the
 * defaults in styles.css so a custom colour lands in the same visual place.
 */
export function brandRamp(themeColor: string): Record<string, string> | null {
  const base = parseHex(themeColor)
  if (!base) return null
  const shade: [number, number, number] = [...SHADE]
  const tint: [number, number, number] = [...TINT]
  return {
    '--brand-900': mix(base, shade, 0.3),
    '--brand-800': mix(base, shade, 0.45),
    '--brand-700': mix(base, shade, 0.68),
    '--brand-500': toHex(base),
    '--brand-300': mix(base, tint, 0.62),
    '--brand-100': mix(base, tint, 0.16),
  }
}

function initialsFor(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return '—'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const authenticated = status === 'authenticated'

  const { data, isLoading } = useQuery({
    queryKey: ['organization'],
    queryFn: () => get<OrganizationProfile>('/organization'),
    enabled: authenticated,
    staleTime: 5 * 60_000,
  })

  const themeColor = data?.themeColor ?? DEFAULT_THEME_COLOR
  const name = data?.name ?? FALLBACK_NAME

  // The logo needs the bearer token, so it cannot be an <img src>. Keyed on
  // logoUpdatedAt so replacing the logo refetches instead of serving a stale one.
  const { data: logoBlob } = useQuery({
    queryKey: ['organization', 'logo', data?.logoUpdatedAt],
    queryFn: () => fetchBlob('/organization/logo'),
    enabled: authenticated && data?.hasLogo === true,
    staleTime: Infinity,
  })

  const [logoUrl, setLogoUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!logoBlob) {
      setLogoUrl(null)
      return
    }
    const url = URL.createObjectURL(logoBlob)
    setLogoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [logoBlob])

  // Paint the ramp onto the root element. Removing the properties on cleanup
  // lets the stylesheet defaults take over again after sign-out.
  useEffect(() => {
    const ramp = brandRamp(themeColor)
    if (!ramp) return
    const root = document.documentElement
    for (const [token, value] of Object.entries(ramp)) root.style.setProperty(token, value)
    return () => {
      for (const token of Object.keys(ramp)) root.style.removeProperty(token)
    }
  }, [themeColor])

  // Keep the browser chrome and the installed PWA title in step with the org.
  useEffect(() => {
    if (!data?.name) return
    document.title = `${data.name} · People operations`
  }, [data?.name])

  useEffect(() => {
    const ramp = brandRamp(themeColor)
    if (!ramp) return
    const meta = document.querySelector('meta[name="theme-color"][media="(prefers-color-scheme: light)"]')
    meta?.setAttribute('content', ramp['--brand-800'])
  }, [themeColor])

  const value = useMemo<BrandingContextValue>(
    () => ({
      name,
      initials: initialsFor(name),
      themeColor,
      logoUrl,
      isLoading: authenticated && isLoading,
    }),
    [name, themeColor, logoUrl, authenticated, isLoading],
  )

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>
}

export function useBranding(): BrandingContextValue {
  const context = useContext(BrandingContext)
  if (!context) throw new Error('useBranding must be used inside BrandingProvider')
  return context
}
