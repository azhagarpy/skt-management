/* eslint-env serviceworker */

/**
 * App-shell service worker.
 *
 * What is cached: the built static assets and the navigation shell, so the app
 * opens offline and shows its own "you are offline" state rather than the
 * browser's error page.
 *
 * What is never cached: anything under the API prefix. Payroll, documents and
 * payslips are sensitive and must not sit in a cache that survives sign-out
 * (plan sections 53 and 64).
 */

const VERSION = 'v1'
const SHELL_CACHE = `sktransport-shell-${VERSION}`
const ASSET_CACHE = `sktransport-assets-${VERSION}`

const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/offline.html']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

/** Lets a fresh worker take over immediately when the page asks it to. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

function isApiRequest(url) {
  return url.pathname.startsWith('/api/')
}

function isHashedAsset(url) {
  return url.pathname.startsWith('/assets/')
}

self.addEventListener('fetch', (event) => {
  const request = event.request

  // Only GET is ever served from cache; a mutation must always reach the server.
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Same-origin only: never intercept third-party requests.
  if (url.origin !== self.location.origin) return

  // API traffic is always network-only, with no cache fallback.
  if (isApiRequest(url)) return

  // Navigations: network first, falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy))
          return response
        })
        .catch(async () => {
          const cached = await caches.match('/index.html')
          return cached ?? caches.match('/offline.html')
        }),
    )
    return
  }

  // Build output is content-hashed, so cache-first is safe and fast.
  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
      }),
    )
    return
  }

  // Everything else: try the network, fall back to whatever was cached.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(() => caches.match(request)),
  )
})
