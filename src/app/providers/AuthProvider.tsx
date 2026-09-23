import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { post, request, setAccessToken, setUnauthenticatedHandler } from '../../lib/api'
import type { AuthResult, RoleKey, SessionUser } from '../../types/api'

/**
 * Session state for the whole app.
 *
 * The access token lives in memory; the refresh token is an httpOnly cookie, so
 * a page reload restores the session by calling refresh rather than reading a
 * token out of storage (plan section 53).
 */

interface AuthContextValue {
  user: SessionUser | null
  status: 'loading' | 'authenticated' | 'unauthenticated'
  login: (identifier: string, password: string) => Promise<SessionUser>
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
  /** True when the signed-in user holds the permission. */
  can: (permission: string) => boolean
  canAny: (...permissions: string[]) => boolean
  hasRole: (...roles: RoleKey[]) => boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [status, setStatus] = useState<AuthContextValue['status']>('loading')

  const clearSession = useCallback(() => {
    setAccessToken(null)
    setUser(null)
    setStatus('unauthenticated')
  }, [])

  // Let the API client tear down the session when a refresh fails.
  useEffect(() => {
    setUnauthenticatedHandler(clearSession)
    return () => setUnauthenticatedHandler(null)
  }, [clearSession])

  // On first load, try to restore the session from the refresh cookie.
  useEffect(() => {
    let cancelled = false

    const restore = async (): Promise<void> => {
      try {
        const response = await request<AuthResult>('/auth/refresh', {
          method: 'POST',
          body: {},
          skipAuthRefresh: true,
        })
        if (cancelled) return
        setAccessToken(response.data.accessToken)
        setUser(response.data.user)
        setStatus('authenticated')
      } catch {
        if (cancelled) return
        setAccessToken(null)
        setUser(null)
        setStatus('unauthenticated')
      }
    }

    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (identifier: string, password: string): Promise<SessionUser> => {
    // A rejected sign-in is not an expired session, so it must not trigger the
    // refresh-and-retry path.
    const response = await request<AuthResult>('/auth/login', {
      method: 'POST',
      body: { identifier, password },
      skipAuthRefresh: true,
    })
    setAccessToken(response.data.accessToken)
    setUser(response.data.user)
    setStatus('authenticated')
    return response.data.user
  }, [])

  const logout = useCallback(async (): Promise<void> => {
    try {
      await post('/auth/logout')
    } catch {
      // Signing out locally must succeed even if the server call fails.
    }
    clearSession()
  }, [clearSession])

  const refreshUser = useCallback(async (): Promise<void> => {
    const response = await request<SessionUser>('/auth/me')
    setUser(response.data)
  }, [])

  const value = useMemo<AuthContextValue>(() => {
    const permissions = new Set(user?.permissions ?? [])
    return {
      user,
      status,
      login,
      logout,
      refreshUser,
      can: (permission) => permissions.has(permission),
      canAny: (...codes) => codes.some((code) => permissions.has(code)),
      hasRole: (...roles) => (user ? roles.includes(user.role) : false),
    }
  }, [user, status, login, logout, refreshUser])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside an AuthProvider')
  return context
}
