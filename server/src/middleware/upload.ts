import multer from 'multer'
import { env } from '../config/env.js'
import { ApiError } from '../utils/api-error.js'

/**
 * Uploads are buffered in memory so the content type can be sniffed and the
 * bytes hashed before anything touches durable storage. The multer-reported
 * mimetype is only a first filter; `documents.service` re-checks the magic bytes.
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
    files: 1,
    fields: 20,
  },
  fileFilter: (_req, file, callback) => {
    const declared = file.mimetype.toLowerCase()
    if (['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'].includes(declared)) {
      callback(null, true)
      return
    }
    callback(null, false)
  },
})

export const uploadSingleDocument = upload.single('file')

/**
 * Logo uploads. Images only, and much smaller than a document: a logo is
 * rendered in a 32px chrome slot, so anything large is a mistake. The declared
 * type is still only a first filter - `organization.service` sniffs the bytes.
 */
const LOGO_MAX_BYTES = 2 * 1024 * 1024

export const uploadSingleImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 1, fields: 5 },
  fileFilter: (_req, file, callback) => {
    const declared = file.mimetype.toLowerCase()
    callback(null, ['image/jpeg', 'image/png', 'image/jpg'].includes(declared))
  },
}).single('file')

/**
 * Face ID attendance sheets (.xlsx). Judged by extension because browsers report
 * spreadsheets inconsistently (often application/octet-stream); the parser then
 * checks the zip signature, so the extension is not trusted on its own.
 */
export const uploadAttendanceSheet = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8 },
  fileFilter: (_req, file, callback) => {
    callback(null, file.originalname.toLowerCase().endsWith('.xlsx'))
  },
}).single('file')

/**
 * A reference document sent with a bulk payment (receipt, bank advice, cheque
 * copy). Unlike the silent filters above, a wrong type is an error: the file is
 * optional, so quietly dropping it would record payments the admin believes are
 * backed by a document when they are not.
 */
export const uploadPaymentProof = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024, files: 1, fields: 12 },
  fileFilter: (_req, file, callback) => {
    const declared = file.mimetype.toLowerCase()
    if (['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'].includes(declared)) {
      callback(null, true)
      return
    }
    callback(ApiError.badRequest('The reference document must be a PDF, PNG or JPEG file'))
  },
}).single('file')
