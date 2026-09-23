import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { EmptyState, ErrorState, Spinner } from '../ui'

/**
 * The shared table.
 *
 * On desktop it renders a real `<table>`; below the tablet breakpoint each row
 * collapses into a card, which is how the same screens stay usable on a phone
 * (plan section 46) without a second set of components.
 */

export interface Column<T> {
  key: string
  header: string
  /** Renders the cell. Keep it presentational; the row is the source of truth. */
  render: (row: T) => ReactNode
  /** Set when the column can drive server-side sorting. */
  sortKey?: string
  align?: 'left' | 'right' | 'center'
  /** Hidden on the mobile card layout when the value is secondary. */
  hideOnMobile?: boolean
  width?: string
}

export interface DataTableProps<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  emptyTitle?: string
  emptyDescription?: string
  emptyAction?: ReactNode
  onRowClick?: (row: T) => void
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  onSortChange?: (sortBy: string, sortOrder: 'asc' | 'desc') => void
  /** Rendered under the last row, for totals. */
  footer?: ReactNode
  caption?: string
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  error,
  onRetry,
  emptyTitle = 'Nothing to show',
  emptyDescription,
  emptyAction,
  onRowClick,
  sortBy,
  sortOrder = 'asc',
  onSortChange,
  footer,
  caption,
}: DataTableProps<T>) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (loading && rows.length === 0) return <Spinner />
  if (!loading && rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
  }

  const handleSort = (column: Column<T>): void => {
    if (!column.sortKey || !onSortChange) return
    const nextOrder = sortBy === column.sortKey && sortOrder === 'asc' ? 'desc' : 'asc'
    onSortChange(column.sortKey, nextOrder)
  }

  return (
    <div className={`data-table-wrapper${loading ? ' is-refreshing' : ''}`}>
      <table className="data-table">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={`align-${column.align ?? 'left'}${column.sortKey ? ' sortable' : ''}`}
              >
                {column.sortKey && onSortChange ? (
                  <button type="button" className="sort-button" onClick={() => handleSort(column)}>
                    {column.header}
                    {sortBy === column.sortKey ? (
                      sortOrder === 'asc' ? (
                        <ArrowUp size={12} aria-hidden />
                      ) : (
                        <ArrowDown size={12} aria-hidden />
                      )
                    ) : (
                      <ArrowUpDown size={12} aria-hidden className="sort-idle" />
                    )}
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? 'clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onRowClick(row)
                      }
                    }
                  : undefined
              }
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  data-label={column.header}
                  className={`align-${column.align ?? 'left'}${column.hideOnMobile ? ' hide-mobile' : ''}`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  )
}
