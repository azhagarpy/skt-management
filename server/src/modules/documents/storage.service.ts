import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { env } from '../../config/env.js'
import { ApiError } from '../../utils/api-error.js'
import { isSafeStorageKey } from '../../utils/files.js'
import { logger } from '../../utils/logger.js'

/**
 * Object storage abstraction.
 *
 * Documents are never exposed through a public URL (plan section 39): the API
 * streams them only after a permission check, so the driver only needs
 * put/get/delete by key. The local driver is the default; an S3-compatible
 * driver can be added behind the same interface without touching callers.
 */
export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
}

const localRoot = resolve(process.cwd(), env.STORAGE_LOCAL_DIR)

function resolveLocalPath(key: string): string {
  if (!isSafeStorageKey(key)) {
    throw ApiError.badRequest('Invalid storage key')
  }
  const target = resolve(join(localRoot, key))
  // Defence in depth: even with a sanitised key, refuse anything that escapes the root.
  if (!target.startsWith(localRoot)) {
    throw ApiError.forbidden('Invalid storage path')
  }
  return target
}

const localDriver: StorageDriver = {
  async put(key, body) {
    const target = resolveLocalPath(key)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body, { mode: 0o600 })
  },
  async get(key) {
    const target = resolveLocalPath(key)
    try {
      return await readFile(target)
    } catch {
      throw ApiError.notFound('Document file')
    }
  },
  async delete(key) {
    const target = resolveLocalPath(key)
    await rm(target, { force: true })
  },
}

/**
 * S3 support is configuration-driven. The dependency is intentionally not
 * bundled: when STORAGE_DRIVER=s3 the operator installs `@aws-sdk/client-s3`
 * and this driver is used. Until then, selecting it fails loudly at startup
 * rather than silently writing to disk.
 */
const s3Driver: StorageDriver = {
  async put() {
    throw ApiError.internal('The S3 storage driver requires @aws-sdk/client-s3 to be installed')
  },
  async get() {
    throw ApiError.internal('The S3 storage driver requires @aws-sdk/client-s3 to be installed')
  },
  async delete() {
    throw ApiError.internal('The S3 storage driver requires @aws-sdk/client-s3 to be installed')
  },
}

export const storage: StorageDriver = env.STORAGE_DRIVER === 's3' ? s3Driver : localDriver

export async function ensureStorageReady(): Promise<void> {
  if (env.STORAGE_DRIVER !== 'local') return
  await mkdir(localRoot, { recursive: true })
  logger.info({ directory: localRoot }, 'Local document storage ready')
}
