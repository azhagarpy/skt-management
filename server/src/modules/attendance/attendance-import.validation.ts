import { z } from 'zod'
import { isoDateSchema } from '../employees/employees.validation.js'

export const conflictModeSchema = z.enum(['OVERRIDE', 'KEEP'])
export type ConflictMode = z.infer<typeof conflictModeSchema>

/** Multipart text fields: an unset field arrives absent or as an empty string. */
const emptyToUndefined = (value: unknown): unknown => (value === '' ? undefined : value)

/**
 * Fields sent alongside the uploaded .xlsx.
 *
 * `from`/`to` pick the days to import - one day (`from` only, or from = to) or a
 * range; both omitted means every date in the sheet. `year` is only needed for a
 * muster whose headers have no year and whose file name does not give one.
 */
export const attendanceImportBodySchema = z.object({
  from: z.preprocess(emptyToUndefined, isoDateSchema.optional()),
  to: z.preprocess(emptyToUndefined, isoDateSchema.optional()),
  year: z.preprocess(emptyToUndefined, z.coerce.number().int().min(2000).max(2100).optional()),
  conflictMode: z.preprocess(emptyToUndefined, conflictModeSchema.optional()),
})

export type AttendanceImportBody = z.infer<typeof attendanceImportBodySchema>
