/**
 * The API client.
 *
 * Wraps fetch with the shared response envelope, bearer-token auth and
 * transparent refresh: when a request comes back 401 the client refreshes once
 * and replays the request, so screens never have to think about token expiry.
 *
 * The access token is kept in memory only. The refresh token lives in an
 * httpOnly cookie set by the API, so no long-lived credential is readable by
 * page scripts (plan section 53).
 */

export const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/v1'

export interface ApiErrorDetail {
  field?: string
  message: string
  [key: string]: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: ApiErrorDetail[]

  constructor(status: number, code: string, message: string, details: ApiErrorDetail[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }

  /** Field-keyed messages, for feeding straight into react-hook-form. */
  get fieldErrors(): Record<string, string> {
    const errors: Record<string, string> = {}
    for (const detail of this.details) {
      if (detail.field) errors[detail.field] = detail.message
    }
    return errors
  }
}

export interface ApiMeta {
  page?: number
  pageSize?: number
  total?: number
  totalPages?: number
  [key: string]: unknown
}

export interface ApiResponse<T> {
  data: T
  message?: string
  meta?: ApiMeta
}

let accessToken: string | null = null
let refreshPromise: Promise<boolean> | null = null
let onUnauthenticated: (() => void) | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

/** Registered by the auth provider so a failed refresh can clear the session. */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  signal?: AbortSignal
  /** Set for multipart uploads, where the browser must pick the boundary. */
  formData?: FormData
  skipAuthRefresh?: boolean
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
  if (!query) return url

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.append(key, String(value))
  }
  const queryString = params.toString()
  return queryString ? `${url}?${queryString}` : url
}

async function parseError(response: Response): Promise<ApiError> {
  let code = 'INTERNAL_ERROR'
  let message = response.statusText || 'Request failed'
  let details: ApiErrorDetail[] = []

  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; details?: ApiErrorDetail[] } }
    if (body.error) {
      code = body.error.code ?? code
      message = body.error.message ?? message
      details = body.error.details ?? []
    }
  } catch {
    // A non-JSON error body (a proxy error page, say) keeps the status text.
  }

  return new ApiError(response.status, code, message, details)
}

/** Refreshes the access token, coalescing concurrent callers onto one request. */
async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    try {
      const response = await fetch(buildUrl('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      })
      if (!response.ok) return false

      const body = (await response.json()) as { data?: { accessToken?: string } }
      if (!body.data?.accessToken) return false

      accessToken = body.data.accessToken
      return true
    } catch {
      return false
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const { method = 'GET', body, query, signal, formData, skipAuthRefresh } = options

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`
    if (!formData && body !== undefined) headers['Content-Type'] = 'application/json'

    return fetch(buildUrl(path, query), {
      method,
      headers,
      credentials: 'include',
      signal,
      body: formData ?? (body === undefined ? undefined : JSON.stringify(body)),
    })
  }

  let response = await send()

  // One transparent refresh-and-retry, then give up and clear the session.
  if (response.status === 401 && !skipAuthRefresh) {
    const refreshed = await refreshSession()
    if (refreshed) {
      response = await send()
    } else {
      accessToken = null
      onUnauthenticated?.()
    }
  }

  if (!response.ok) throw await parseError(response)

  if (response.status === 204) return { data: null as T }

  const payload = (await response.json()) as { data: T; message?: string; meta?: ApiMeta }
  return { data: payload.data, message: payload.message, meta: payload.meta }
}

export async function get<T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal): Promise<T> {
  const response = await request<T>(path, { method: 'GET', query, signal })
  return response.data
}

/** GET that also returns pagination metadata. */
export async function getWithMeta<T>(
  path: string,
  query?: RequestOptions['query'],
  signal?: AbortSignal,
): Promise<{ data: T; meta?: ApiMeta }> {
  const response = await request<T>(path, { method: 'GET', query, signal })
  return { data: response.data, meta: response.meta }
}

export async function post<T>(path: string, body?: unknown, query?: RequestOptions['query']): Promise<ApiResponse<T>> {
  return request<T>(path, { method: 'POST', body, query })
}

export async function patch<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  return request<T>(path, { method: 'PATCH', body })
}

export async function put<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  return request<T>(path, { method: 'PUT', body })
}

export async function del<T>(path: string): Promise<ApiResponse<T>> {
  return request<T>(path, { method: 'DELETE' })
}

export async function upload<T>(path: string, formData: FormData): Promise<ApiResponse<T>> {
  return request<T>(path, { method: 'POST', formData })
}

/**
 * Fetches a protected file as a blob.
 *
 * Same auth-and-replay path as `download`, but hands back the blob instead of
 * saving it - for images the app renders inline, such as the organization logo,
 * which cannot be an <img src> because the API expects a bearer token.
 */
export async function fetchBlob(path: string, query?: RequestOptions['query']): Promise<Blob> {
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`
    return fetch(buildUrl(path, query), { headers, credentials: 'include' })
  }

  let response = await send()
  if (response.status === 401) {
    const refreshed = await refreshSession()
    if (refreshed) response = await send()
    else {
      accessToken = null
      onUnauthenticated?.()
    }
  }

  if (!response.ok) throw await parseError(response)
  return response.blob()
}

/**
 * Downloads a protected file.
 *
 * Documents and payslips are never public URLs, so the browser cannot simply
 * follow a link: the file is fetched with the bearer token and handed to the
 * user as a blob.
 */
export async function download(path: string, filename: string, query?: RequestOptions['query']): Promise<Headers> {
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`
    return fetch(buildUrl(path, query), { headers, credentials: 'include' })
  }

  let response = await send()
  if (response.status === 401) {
    const refreshed = await refreshSession()
    if (refreshed) response = await send()
    else {
      accessToken = null
      onUnauthenticated?.()
    }
  }

  if (!response.ok) throw await parseError(response)

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = objectUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()

  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)

  return response.headers
}

/**
 * Downloads a protected file produced from a POST body - the same flow as
 * `download`, but for requests too large (or too structured) for a query
 * string, such as a chosen list of employee ids.
 */
export async function downloadPost(path: string, filename: string, body: unknown): Promise<Headers> {
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`
    return fetch(buildUrl(path), { method: 'POST', headers, credentials: 'include', body: JSON.stringify(body) })
  }

  let response = await send()
  if (response.status === 401) {
    const refreshed = await refreshSession()
    if (refreshed) response = await send()
    else {
      accessToken = null
      onUnauthenticated?.()
    }
  }

  if (!response.ok) throw await parseError(response)

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = objectUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()

  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)

  return response.headers
}
