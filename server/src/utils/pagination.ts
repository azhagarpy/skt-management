import { z } from 'zod'

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sortBy: z.string().max(64).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
})

export type PaginationInput = z.infer<typeof paginationSchema>

export interface Paginated<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export function buildPaginated<T>(items: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  }
}

export function offsetOf(page: number, pageSize: number): number {
  return (page - 1) * pageSize
}

/**
 * Guards ORDER BY against injection: only columns explicitly allow-listed by the
 * calling repository can be used.
 */
export function safeSort(
  sortBy: string | undefined,
  sortOrder: 'asc' | 'desc',
  allowed: Readonly<Record<string, string>>,
  fallback: string,
): string {
  const column = sortBy && sortBy in allowed ? allowed[sortBy] : fallback
  const direction = sortOrder === 'desc' ? 'DESC' : 'ASC'
  return `${column} ${direction}`
}
