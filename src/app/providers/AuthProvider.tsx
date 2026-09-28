import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, post, request, setAccessToken, setLockedHandler, setUnauthenticatedHandler } from '../../lib/api'
import type { AuthResult, RoleKey, SessionUser } from '../../types/api'

/**
 * Session state for the whole app.
 *
 * The access token lives in memory; the refresh token is an httpOnly cookie, so
 * a page reload restores the session by calling refresh rather than reading a
 * token out of storage (plan section 53).
 *
 * With an app lock PIN set, a restored session comes back `locked`: the server
 * hands out a token that only the unlock endpoint accepts, and the app shows
 * the PIN screen until `unlock` succeeds.
 */

interface AuthContextValue {
  user: SessionUser | null
  status: 'loading' | 'authenticated' | 'locked' | 'unauthenticated'
  login: (identifier: string, password: string) => Promise<SessionUser>
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
  /** Enters the app lock PIN. Rejects with the server's message when it is wrong. */
  unlock: (pin: string) => Promise<void>
  /** Locks this page now, as if it had just been opened. */
  lock: () => Promise<void>
  /** Why the user was last signed out, when it was not their own doing. Shown on the sign-in page. */
  signOutNotice: string | null
  /** True when the signed-in user holds the permission. */
  can: (permission: string) => boolean
  canAny: (...permissions: string[]) => boolean
  hasRole: (...roles: RoleKey[]) => boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<SessionUser | null>(null)
  const [status, setStatus] = useState<AuthContextValue['status']>('loading')
  const [signOutNotice, setSignOutNotice] = useState<string | null>(null)

  const clearSession = useCallback(() => {
    setAccessToken(null)
    setUser(null)
    setStatus('unauthenticated')
  }, [])

  // Nothing fetched before the lock should stay readable behind it.
  const showLock = useCallback(() => {
    queryClient.clear()
    setStatus('locked')
  }, [queryClient])

  // Let the API client tear down the session when a refresh fails, and show
  // the PIN screen when the server says this page is locked.
  useEffect(() => {
    setUnauthenticatedHandler(clearSession)
    setLockedHandler(showLock)
    return () => {
      setUnauthenticatedHandler(null)
      setLockedHandler(null)
    }
  }, [clearSession, showLock])

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
        setStatus(response.data.appLocked ? 'locked' : 'authenticated')
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
    setSignOutNotice(null)
    return response.data.user
  }, [])

  const unlock = useCallback(
    async (pin: string): Promise<void> => {
      try {
        const response = await request<{ user: SessionUser; accessToken: string }>('/auth/pin/unlock', {
          method: 'POST',
          body: { pin },
          skipAuthRefresh: true,
        })
        setAccessToken(response.data.accessToken)
        setUser(response.data.user)
        setStatus('authenticated')
      } catch (error) {
        // Too many wrong PINs: the server has signed this session out.
        if (error instanceof ApiError && error.status === 401) {
          setSignOutNotice(error.message)
          clearSession()
        }
        throw error
      }
    },
    [clearSession],
  )

  const lock = useCallback(async (): Promise<void> => {
    // Dropping the in-memory token first makes the refresh look like a fresh
    // page, which the server answers with a locked token.
    setAccessToken(null)
    try {
      const response = await request<AuthResult>('/auth/refresh', { method: 'POST', body: {}, skipAuthRefresh: true })
      setAccessToken(response.data.accessToken)
      setUser(response.data.user)
      if (response.data.appLocked) showLock()
      else setStatus('authenticated')
    } catch {
      clearSession()
    }
  }, [clearSession, showLock])

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
      unlock,
      lock,
      signOutNotice,
      can: (permission) => permissions.has(permission),
      canAny: (...codes) => codes.some((code) => permissions.has(code)),
      hasRole: (...roles) => (user ? roles.includes(user.role) : false),
    }
  }, [user, status, login, logout, refreshUser, unlock, lock, signOutNotice])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside an AuthProvider')
  return context
}
