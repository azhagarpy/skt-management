/**
 * Service worker registration (plan section 64).
 *
 * The worker caches the app shell only. Payroll figures, documents and payslips
 * are deliberately never cached: they are sensitive, and a stale salary number
 * is worse than no number at all.
 */

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  // Registering in dev competes with Vite's HMR, so it is production only.
  if (import.meta.env.DEV) return

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // Check for an updated worker on each load.
        registration.update().catch(() => undefined)
      })
      .catch(() => {
        // A failed registration must never break the app; it simply means no
        // offline shell on this device.
      })
  })
}

export async function unregisterServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const registrations = await navigator.serviceWorker.getRegistrations()
  await Promise.all(registrations.map((registration) => registration.unregister()))
}

/** True when the app is running as an installed PWA rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}
