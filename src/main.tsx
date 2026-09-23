import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './styles.css'
import { AuthProvider } from './app/providers/AuthProvider'
import { BrandingProvider } from './app/providers/BrandingProvider'
import { ToastProvider } from './app/providers/ToastProvider'
import { AppRouter } from './app/router'
import { ApiError } from './lib/api'
import { registerServiceWorker } from './lib/pwa'

/**
 * Query defaults.
 *
 * Retrying a 4xx is pointless and, for a 403, misleading, so retries are limited
 * to genuine server or network failures.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false
        return failureCount < 2
      },
    },
    mutations: {
      retry: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <BrandingProvider>
            <ToastProvider>
              <AppRouter />
            </ToastProvider>
          </BrandingProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)

registerServiceWorker()
