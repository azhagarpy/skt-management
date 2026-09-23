import { createHash, randomUUID } from 'node:crypto'
import { extname } from 'node:path'

/**
 * Allowed upload formats (plan section 52). The client-supplied MIME type is
 * never trusted: the real type is sniffed from the file's magic bytes.
 */
export const ALLOWED_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type AllowedUploadType = (typeof ALLOWED_UPLOAD_TYPES)[number]

const EXTENSION_BY_TYPE: Record<AllowedUploadType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

function startsWith(buffer: Buffer, signature: number[], offset = 0): boolean {
  if (buffer.length < offset + signature.length) return false
  return signature.every((byte, index) => buffer[offset + index] === byte)
}

/** Returns the real content type of a buffer, or null when it is not allowed. */
export function sniffContentType(buffer: Buffer): AllowedUploadType | null {
  // %PDF
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf'
  // JPEG SOI marker
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  // PNG signature
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  return null
}

export function extensionForType(type: AllowedUploadType): string {
  return EXTENSION_BY_TYPE[type]
}

/**
 * Strips directory components and control characters from a client filename so
 * it is safe to store and display. The result is never used as a storage key.
 */
export function sanitiseFilename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? 'file'
  const cleaned = base
    // Anything outside this conservative set (control characters included) is dropped.
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const safe = cleaned.length > 0 ? cleaned : 'file'
  return safe.slice(0, 180)
}

/**
 * Builds an opaque, collision-free storage key. Original filenames are never
 * used as keys (plan section 52).
 */
export function buildStorageKey(params: {
  organizationId: string
  employeeId: string
  category: string
  contentType: AllowedUploadType
}): string {
  const { organizationId, employeeId, category, contentType } = params
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const slug = category.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return `${organizationId}/${year}/${month}/${employeeId}/${slug}-${randomUUID()}.${extensionForType(contentType)}`
}

/** Storage key for an organization's logo. Old keys are deleted on replace. */
export function buildBrandingStorageKey(organizationId: string, contentType: AllowedUploadType): string {
  return `${organizationId}/branding/logo-${randomUUID()}.${extensionForType(contentType)}`
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function isSafeStorageKey(key: string): boolean {
  if (key.includes('..') || key.startsWith('/') || key.includes('\\')) return false
  return /^[A-Za-z0-9/_.-]+$/.test(key)
}

export function displayExtension(filename: string): string {
  return extname(filename).replace('.', '').toLowerCase()
}
