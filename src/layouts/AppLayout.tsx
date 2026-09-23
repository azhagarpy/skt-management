import { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, ChevronDown, Compass, LogOut, Menu, WifiOff, X } from 'lucide-react'
import { useAuth } from '../app/providers/AuthProvider'
import { useBranding } from '../app/providers/BrandingProvider'
import { ProductTour, hasSeenTour } from '../app/tour/ProductTour'
import { get, post } from '../lib/api'
import { formatRelative, humanise } from '../lib/format'
import { Avatar, Badge, Button } from '../components/ui'
import { MOBILE_NAV, NAV_GROUPS, filterMobileNav, filterNav } from '../app/router/navigation'
import type { NotificationItem } from '../types/api'

/**
 * The application shell.
 *
 * Desktop gets a sidebar and top bar; below the tablet breakpoint the sidebar
 * becomes a drawer and a bottom bar carries the primary destinations, which is
 * what makes the PWA comfortable on a phone (plan section 46).
 */
export function AppLayout() {
  const { user, logout, canAny } = useAuth()
  const { name: orgName, initials, logoUrl } = useBranding()
  const [tourOpen, setTourOpen] = useState(false)
  const tourOpenedDrawer = useRef(false)

  /**
   * Starts the tour, making sure it has something to point at first: below
   * 1024px the sidebar is a drawer parked off-screen, so it is opened and given
   * time to slide in before the tour measures its targets.
   */
  const startTour = useCallback((): void => {
    const needsDrawer = window.innerWidth <= 1024
    if (needsDrawer) {
      tourOpenedDrawer.current = true
      setDrawerOpen(true)
    }
    window.setTimeout(() => setTourOpen(true), needsDrawer ? 320 : 0)
  }, [])

  const endTour = useCallback((): void => {
    setTourOpen(false)
    if (tourOpenedDrawer.current) {
      tourOpenedDrawer.current = false
      setDrawerOpen(false)
    }
  }, [])

  // First sign-in for this user: introduce the modules once. The nav has to be
  // painted before the tour can measure it, hence the deferred start.
  useEffect(() => {
    if (!user || hasSeenTour(user.id)) return
    const timer = window.setTimeout(startTour, 400)
    return () => window.clearTimeout(timer)
  }, [user, startTour])
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)

  // Close transient UI whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false)
    setMenuOpen(false)
    setNotificationsOpen(false)
  }, [location.pathname])

  // Network status indicator (plan section 64).
  useEffect(() => {
    const goOnline = (): void => setOnline(true)
    const goOffline = (): void => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => get<{ unread: number }>('/notifications/unread-count'),
    refetchInterval: 60_000,
    enabled: Boolean(user),
  })

  const { data: notifications } = useQuery({
    queryKey: ['notifications', 'recent'],
    queryFn: () => get<NotificationItem[]>('/notifications', { pageSize: 8 }),
    enabled: notificationsOpen,
  })

  const hasEmployeeRecord = Boolean(user?.employeeId)
  const navGroups = filterNav(NAV_GROUPS, canAny, hasEmployeeRecord)
  const mobileNav = filterMobileNav(MOBILE_NAV, canAny, 5, hasEmployeeRecord)

  const handleLogout = async (): Promise<void> => {
    await logout()
    queryClient.clear()
    navigate('/login', { replace: true })
  }

  const markAllRead = async (): Promise<void> => {
    await post('/notifications/read-all')
    await queryClient.invalidateQueries({ queryKey: ['notifications'] })
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      {/* Sidebar, and its mobile drawer twin. */}
      <aside
        className={`sidebar${drawerOpen ? ' sidebar-open' : ''}`}
        aria-label="Main navigation"
        data-tour="sidebar"
      >
        <div className="sidebar-header">
          <div className="brand">
            {/* Identity comes from the organization record, not a constant. */}
            {logoUrl ? (
              <img className="brand-logo" src={logoUrl} alt="" aria-hidden />
            ) : (
              <span className="brand-mark" aria-hidden>
                {initials}
              </span>
            )}
            <span className="brand-name">{orgName}</span>
          </div>
          <button
            type="button"
            className="drawer-close"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {navGroups.map((group) => (
            <div key={group.label} className="nav-group">
              <p className="nav-group-label">{group.label}</p>
              <ul>
                {group.items.map((item) => {
                  const Icon = item.icon
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.end}
                        data-tour-nav={item.to}
                        className={({ isActive }) => `nav-link${isActive ? ' nav-link-active' : ''}`}
                      >
                        {Icon ? <Icon size={16} aria-hidden /> : null}
                        <span>{item.label}</span>
                      </NavLink>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <p className="sidebar-role">{user ? humanise(user.role) : ''}</p>
        </div>
      </aside>

      {drawerOpen ? <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} /> : null}

      <div className="app-main">
        <header className="topbar">
          <button
            type="button"
            className="drawer-toggle"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
          >
            <Menu size={20} />
          </button>

          <div className="topbar-spacer" />

          {!online ? (
            <span className="offline-pill" role="status">
              <WifiOff size={14} aria-hidden /> Offline
            </span>
          ) : null}

          <div className="topbar-actions">
            <div className="notification-menu" data-tour="notifications">
              <button
                type="button"
                className="icon-button"
                onClick={() => setNotificationsOpen((open) => !open)}
                aria-label="Notifications"
                aria-expanded={notificationsOpen}
              >
                <Bell size={18} />
                {unread && unread.unread > 0 ? <span className="notification-dot">{unread.unread}</span> : null}
              </button>

              {notificationsOpen ? (
                <div className="dropdown notification-dropdown" role="menu">
                  <div className="dropdown-header">
                    <p>Notifications</p>
                    <Button variant="ghost" size="sm" onClick={markAllRead}>
                      Mark all read
                    </Button>
                  </div>
                  <div className="notification-list">
                    {(notifications ?? []).length === 0 ? (
                      <p className="dropdown-empty">You are all caught up.</p>
                    ) : (
                      (notifications ?? []).map((notification) => (
                        <div key={notification.id} className={`notification${notification.isRead ? '' : ' unread'}`}>
                          <p className="notification-title">{notification.title}</p>
                          <p className="notification-body">{notification.body}</p>
                          <p className="notification-time">{formatRelative(notification.createdAt)}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="user-menu" data-tour="account">
              <button
                type="button"
                className="user-button"
                onClick={() => setMenuOpen((open) => !open)}
                aria-expanded={menuOpen}
              >
                <Avatar name={user?.fullName ?? '?'} size={30} />
                <span className="user-name">{user?.fullName}</span>
                <ChevronDown size={14} aria-hidden />
              </button>

              {menuOpen ? (
                <div className="dropdown user-dropdown" role="menu">
                  <div className="dropdown-header">
                    <p>{user?.fullName}</p>
                    <p className="dropdown-subtle">{user?.email}</p>
                    <Badge tone="info">{user ? humanise(user.role) : ''}</Badge>
                  </div>
                  {hasEmployeeRecord ? (
                    <NavLink to="/my-profile" className="dropdown-item">
                      My profile
                    </NavLink>
                  ) : null}
                  <NavLink to="/change-password" className="dropdown-item">
                    Change password
                  </NavLink>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setMenuOpen(false)
                      startTour()
                    }}
                  >
                    <Compass size={14} aria-hidden /> Take the tour
                  </button>
                  <button type="button" className="dropdown-item dropdown-item-danger" onClick={handleLogout}>
                    <LogOut size={14} aria-hidden /> Sign out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <main id="main-content" className="app-content">
          <Outlet />
        </main>

        <ProductTour open={tourOpen} onClose={endTour} />

        <nav className="bottom-nav" aria-label="Primary">
          {mobileNav.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `bottom-nav-item${isActive ? ' active' : ''}`}
              >
                {Icon ? <Icon size={18} aria-hidden /> : null}
                <span>{item.label}</span>
              </NavLink>
            )
          })}
        </nav>
      </div>
    </div>
  )
}
