import { z } from 'zod'

/**
 * A query filter that takes one or more ids.
 *
 * `?departmentId=a`, `?departmentId=a,b` and a repeated
 * `?departmentId=a&departmentId=b` all arrive as `['a', 'b']`, so a screen that
 * lets people pick several departments and one that sends a single id use the
 * same parameter. An empty value is an empty list, which filters nothing.
 */
export const idListParam = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(','))
      .map((id) => id.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().uuid('Each selected id must be valid')).max(500))
