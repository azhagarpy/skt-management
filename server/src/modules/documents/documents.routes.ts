import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/authenticate.js'
import { requireAnyPermission, requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { uploadSingleDocument } from '../../middleware/upload.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { employeeIdParam } from '../employees/employees.validation.js'
import * as controller from './documents.controller.js'
import {
  aadhaarSchema,
  bankAccountSchema,
  documentListQuerySchema,
  esiSchema,
  panSchema,
  pfSchema,
  uploadDocumentSchema,
  verifyDocumentSchema,
  verifySectionSchema,
} from './documents.validation.js'

/**
 * Mounted under `/employees` so every path is employee-scoped:
 * `/employees/:id/documents`, `/employees/:id/pan`, and so on.
 * `mergeParams` keeps `:id` visible to these handlers.
 */
export const documentRouter = Router({ mergeParams: true })
documentRouter.use(authenticate)

const canRead = requireAnyPermission(
  PERMISSIONS.DOCUMENT_VIEW_ALL,
  PERMISSIONS.DOCUMENT_VIEW_TEAM,
  PERMISSIONS.DOCUMENT_VIEW_SELF,
)
const canWrite = requireAnyPermission(PERMISSIONS.DOCUMENT_UPLOAD_ANY, PERMISSIONS.DOCUMENT_UPLOAD_SELF)

const documentIdParam = employeeIdParam.extend({ documentId: z.string().uuid() })

documentRouter.get(
  '/documents',
  canRead,
  validate({ params: employeeIdParam, query: documentListQuerySchema }),
  controller.listDocuments,
)

documentRouter.post(
  '/documents',
  canWrite,
  // multer runs before validation so the multipart body fields are populated.
  uploadSingleDocument,
  validate({ params: employeeIdParam, body: uploadDocumentSchema }),
  controller.uploadDocument,
)

documentRouter.get(
  '/documents/:documentId/file',
  canRead,
  validate({ params: documentIdParam }),
  controller.downloadDocument,
)

documentRouter.post(
  '/documents/:documentId/verify',
  requirePermissions(PERMISSIONS.DOCUMENT_VERIFY),
  validate({ params: documentIdParam, body: verifyDocumentSchema }),
  controller.verifyDocument,
)

documentRouter.delete(
  '/documents/:documentId',
  requirePermissions(PERMISSIONS.DOCUMENT_DELETE),
  validate({ params: documentIdParam }),
  controller.deleteDocument,
)

// ---------------------------------------------------------------------------
// Identity and financial sections
// ---------------------------------------------------------------------------

documentRouter.get('/identity', canRead, validate({ params: employeeIdParam }), controller.getIdentityProfile)

documentRouter.put('/pan', canWrite, validate({ params: employeeIdParam, body: panSchema }), controller.savePan)
documentRouter.put(
  '/aadhaar',
  canWrite,
  validate({ params: employeeIdParam, body: aadhaarSchema }),
  controller.saveAadhaar,
)
documentRouter.put(
  '/bank-account',
  canWrite,
  validate({ params: employeeIdParam, body: bankAccountSchema }),
  controller.saveBankAccount,
)
documentRouter.put('/pf', canWrite, validate({ params: employeeIdParam, body: pfSchema }), controller.savePf)
documentRouter.put('/esi', canWrite, validate({ params: employeeIdParam, body: esiSchema }), controller.saveEsi)

documentRouter.post(
  '/verify-section',
  requirePermissions(PERMISSIONS.DOCUMENT_VERIFY),
  validate({ params: employeeIdParam, body: verifySectionSchema }),
  controller.verifySection,
)

/**
 * Revealing an unmasked identity number is a separate, audited action rather
 * than a field on the profile response (plan sections 14 and 53).
 */
documentRouter.get(
  '/sensitive/:section',
  canRead,
  validate({ params: employeeIdParam.extend({ section: z.enum(['PAN', 'AADHAAR', 'BANK']) }) }),
  controller.revealSensitive,
)
