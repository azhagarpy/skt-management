import type { Request, Response } from 'express'
import { asyncHandler } from '../../utils/async-handler.js'
import { sendCreated, sendNoContent, sendSuccess } from '../../utils/http.js'
import { requireAuth } from '../../middleware/authenticate.js'
import { ApiError } from '../../utils/api-error.js'
import { auditContextFrom } from '../audit/audit.service.js'
import { requireOwnEmployeeId } from '../employees/employee-access.js'
import { sanitiseFilename } from '../../utils/files.js'
import * as service from './documents.service.js'
import type {
  AadhaarInput,
  BankAccountInput,
  DocumentListQuery,
  EsiInput,
  PanInput,
  PfInput,
  UploadDocumentInput,
  VerifyDocumentInput,
  VerifySectionInput,
} from './documents.validation.js'
import type { AuthContext } from '../../types/express.js'

function targetEmployeeId(auth: AuthContext, param: string | undefined): string {
  if (!param || param === 'me') return requireOwnEmployeeId(auth)
  return param
}

export const listDocuments = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const data = await service.listDocuments(auth, employeeId, req.query as unknown as DocumentListQuery)
  return sendSuccess(res, data)
})

export const uploadDocument = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const file = req.file
  if (!file) throw ApiError.upload('A file is required. Accepted formats: PDF, JPG, PNG')

  const data = await service.uploadDocument(
    auth,
    employeeId,
    { buffer: file.buffer, originalname: file.originalname, size: file.size },
    req.body as UploadDocumentInput,
    auditContextFrom(req),
  )
  return sendCreated(res, data, 'Document uploaded successfully')
})

/**
 * Streams a document only after the permission check inside the service passes.
 * The response is forced to an attachment with a sanitised filename so a crafted
 * upload cannot be rendered inline in the browser (plan section 39).
 */
export const downloadDocument = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const documentId = req.params.documentId as string

  const file = await service.readDocumentFile(auth, employeeId, documentId, auditContextFrom(req))

  res.setHeader('Content-Type', file.mimeType)
  res.setHeader('Content-Length', String(file.buffer.length))
  res.setHeader('Content-Disposition', `attachment; filename="${sanitiseFilename(file.filename)}"`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.send(file.buffer)
})

export const verifyDocument = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const data = await service.verifyDocument(
    auth,
    employeeId,
    req.params.documentId as string,
    req.body as VerifyDocumentInput,
    auditContextFrom(req),
  )
  return sendSuccess(res, data, 'Document verification updated')
})

export const deleteDocument = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  await service.deleteDocument(auth, employeeId, req.params.documentId as string, auditContextFrom(req))
  return sendNoContent(res, 'Document deleted successfully')
})

export const getIdentityProfile = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  return sendSuccess(res, await service.getIdentityProfile(auth, employeeId))
})

export const savePan = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const data = await service.savePan(auth, employeeId, req.body as PanInput, auditContextFrom(req))
  return sendSuccess(res, data, 'PAN details saved successfully')
})

export const saveAadhaar = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const data = await service.saveAadhaar(auth, employeeId, req.body as AadhaarInput, auditContextFrom(req))
  return sendSuccess(res, data, 'Aadhaar details saved successfully')
})

export const saveBankAccount = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const data = await service.saveBankAccount(auth, employeeId, req.body as BankAccountInput, auditContextFrom(req))
  return sendSuccess(res, data, 'Bank details saved successfully')
})

export const savePf = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const data = await service.savePf(auth, employeeId, req.body as PfInput, auditContextFrom(req))
  return sendSuccess(res, data, 'PF details saved successfully')
})

export const saveEsi = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const data = await service.saveEsi(auth, employeeId, req.body as EsiInput, auditContextFrom(req))
  return sendSuccess(res, data, 'ESI details saved successfully')
})

export const verifySection = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const data = await service.verifySection(auth, employeeId, req.body as VerifySectionInput, auditContextFrom(req))
  return sendSuccess(res, data, 'Verification updated')
})

export const revealSensitive = asyncHandler(async (req: Request, res: Response) => {
  const auth = requireAuth(req)
  const employeeId = targetEmployeeId(auth, req.params.id)
  const section = req.params.section as 'PAN' | 'AADHAAR' | 'BANK'
  const data = await service.revealSensitive(auth, employeeId, section, auditContextFrom(req))
  return sendSuccess(res, data)
})
