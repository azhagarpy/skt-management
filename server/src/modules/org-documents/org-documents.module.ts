import { Router } from 'express'
import { z } from 'zod'
import { pool, queryOne, queryRows } from '../../database/pool.js'
import { authenticate, requireAuth } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { uploadSingleDocument } from '../../middleware/upload.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/http.js'
import { ApiError } from '../../utils/api-error.js'
import { buildOrganizationDocumentKey, sanitiseFilename, sha256, sniffContentType } from '../../utils/files.js'
import { logger } from '../../utils/logger.js'
import { auditContextFrom, recordAudit } from '../audit/audit.service.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { storage } from '../documents/storage.service.js'

/**
 * Organization documents: company papers - licences, registrations,
 * agreements - kept against the organization rather than an employee.
 *
 * They follow the employee document rules (plan sections 39 and 52): the real
 * file type is sniffed from its bytes, the file is stored under an opaque
 * server-generated key, and it is only ever streamed back as an attachment
 * after a permission check.
 */

interface OrganizationDocumentRow {
  id: string
  organization_id: string
  title: string
  note: string | null
  storage_key: string
  original_filename: string
  mime_type: string
  file_size_bytes: string
  uploaded_by: string | null
  uploaded_by_name: string | null
  created_at: Date
}

const uploadSchema = z.object({
  title: z.string().trim().min(2, 'A title is required').max(160),
  note: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((value) => (value ? value : null)),
})

const documentIdParam = z.object({ documentId: z.string().uuid() })

const SELECT_DOCUMENT = `
  SELECT d.*, u.full_name AS uploaded_by_name
    FROM organization_documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
`

function presentDocument(row: OrganizationDocumentRow) {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSizeBytes: Number(row.file_size_bytes),
    uploadedByName: row.uploaded_by_name,
    createdAt: row.created_at,
  }
}

async function findDocument(id: string, organizationId: string): Promise<OrganizationDocumentRow> {
  const row = await queryOne<OrganizationDocumentRow>(
    pool,
    `${SELECT_DOCUMENT} WHERE d.id = $1 AND d.organization_id = $2`,
    [id, organizationId],
  )
  if (!row) throw ApiError.notFound('Document')
  return row
}

export const orgDocumentRouter = Router()
orgDocumentRouter.use(authenticate)

orgDocumentRouter.get(
  '/',
  requirePermissions(PERMISSIONS.ORG_DOCUMENT_VIEW),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const rows = await queryRows<OrganizationDocumentRow>(
      pool,
      `${SELECT_DOCUMENT} WHERE d.organization_id = $1 ORDER BY d.created_at DESC`,
      [auth.organizationId],
    )
    return sendSuccess(res, rows.map(presentDocument))
  }),
)

orgDocumentRouter.post(
  '/',
  requirePermissions(PERMISSIONS.ORG_DOCUMENT_MANAGE),
  // multer runs before validation so the multipart body fields are populated.
  uploadSingleDocument,
  validate({ body: uploadSchema }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const input = req.body as z.infer<typeof uploadSchema>
    const file = req.file
    if (!file) throw ApiError.upload('A file is required. Accepted formats: PDF, JPG, PNG')
    if (file.buffer.length === 0) throw ApiError.upload('The uploaded file is empty')

    // The client-declared type is ignored; the real type comes from the bytes.
    const contentType = sniffContentType(file.buffer)
    if (!contentType) throw ApiError.upload('Only PDF, JPG and PNG files are accepted')

    const storageKey = buildOrganizationDocumentKey(auth.organizationId, contentType)
    await storage.put(storageKey, file.buffer, contentType)

    try {
      const inserted = await queryOne<{ id: string }>(
        pool,
        `INSERT INTO organization_documents
           (organization_id, title, note, storage_key, original_filename, mime_type, file_size_bytes,
            checksum_sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          auth.organizationId,
          input.title,
          input.note,
          storageKey,
          sanitiseFilename(file.originalname),
          contentType,
          file.buffer.length,
          sha256(file.buffer),
          auth.userId,
        ],
      )
      const row = await findDocument(inserted!.id, auth.organizationId)

      await recordAudit({
        ...auditContextFrom(req),
        action: 'ORGANIZATION_DOCUMENT_UPLOADED',
        entityType: 'organization_document',
        entityId: row.id,
        newValues: { title: row.title, filename: row.original_filename, sizeBytes: file.buffer.length },
      })

      return sendCreated(res, presentDocument(row), 'Document uploaded successfully')
    } catch (error) {
      // Do not leave an orphaned file behind if the metadata insert fails.
      await storage.delete(storageKey).catch(() => undefined)
      throw error
    }
  }),
)

/**
 * Streams the file only after the permission check. Always an attachment with
 * a sanitised name, so a crafted upload is never rendered inline.
 */
orgDocumentRouter.get(
  '/:documentId/file',
  requirePermissions(PERMISSIONS.ORG_DOCUMENT_VIEW),
  validate({ params: documentIdParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const row = await findDocument(req.params.documentId as string, auth.organizationId)
    const buffer = await storage.get(row.storage_key)

    await recordAudit({
      ...auditContextFrom(req),
      action: 'ORGANIZATION_DOCUMENT_DOWNLOADED',
      entityType: 'organization_document',
      entityId: row.id,
    })

    res.setHeader('Content-Type', row.mime_type)
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Content-Disposition', `attachment; filename="${sanitiseFilename(row.original_filename)}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(buffer)
  }),
)

orgDocumentRouter.delete(
  '/:documentId',
  requirePermissions(PERMISSIONS.ORG_DOCUMENT_MANAGE),
  validate({ params: documentIdParam }),
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req)
    const row = await findDocument(req.params.documentId as string, auth.organizationId)

    await pool.query('DELETE FROM organization_documents WHERE id = $1 AND organization_id = $2', [
      row.id,
      auth.organizationId,
    ])
    // The record is gone either way; a file left behind is only logged.
    await storage.delete(row.storage_key).catch((error: unknown) => {
      logger.warn({ error, key: row.storage_key }, 'Could not delete an organization document file')
    })

    await recordAudit({
      ...auditContextFrom(req),
      action: 'ORGANIZATION_DOCUMENT_DELETED',
      entityType: 'organization_document',
      entityId: row.id,
      oldValues: { title: row.title, filename: row.original_filename },
    })

    return sendNoContent(res, 'Document deleted successfully')
  }),
)
