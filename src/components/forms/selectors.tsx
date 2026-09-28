import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { Upload, X } from 'lucide-react'
import { get, getWithMeta, upload } from '../../lib/api'
import { formatFileSize } from '../../lib/format'
import { Button, Select } from '../ui'
import type { Department, Designation, EmployeeDetail, EmployeeSummary, EmployeeType, LeaveType, Location, SalaryStructure, Shift } from '../../types/api'

/**
 * Reusable pickers.
 *
 * Each one owns its own query with a long stale time: departments and leave
 * types barely change, so every screen that needs them shares one cached fetch.
 */

const REFERENCE_DATA_STALE_TIME = 5 * 60 * 1000

export function useDepartments() {
  return useQuery({
    queryKey: ['departments', 'options'],
    queryFn: () => get<Department[]>('/departments', { isActive: true }),
    staleTime: REFERENCE_DATA_STALE_TIME,
  })
}

export function useDesignations() {
  return useQuery({
    queryKey: ['designations', 'options'],
    queryFn: () => get<Designation[]>('/designations', { isActive: true }),
    staleTime: REFERENCE_DATA_STALE_TIME,
  })
}

export function useEmployeeTypes() {
  return useQuery({
    queryKey: ['employee-types', 'options'],
    queryFn: () => get<EmployeeType[]>('/employee-types', { isActive: true }),
    staleTime: REFERENCE_DATA_STALE_TIME,
  })
}

export function useLocations() {
  return useQuery({
    queryKey: ['locations', 'options'],
    queryFn: () => get<Location[]>('/locations', { isActive: true }),
    staleTime: REFERENCE_DATA_STALE_TIME,
  })
}

export function useLeaveTypes() {
  return useQuery({
    queryKey: ['leave-types', 'options'],
    queryFn: () => get<LeaveType[]>('/leave/types', { activeOnly: 'true' }),
    staleTime: REFERENCE_DATA_STALE_TIME,
  })
}

export function useSalaryStructures() {
  return useQuery({
    queryKey: ['salary-structures', 'options'],
    queryFn: () => get<SalaryStructure[]>('/salary/structures', { activeOnly: 'true' }),
    staleTime: REFERENCE_DATA_STALE_TIME,
  })
}

export function useShifts() {
  return useQuery({
    queryKey: ['shifts', 'options'],
    queryFn: () => get<Shift[]>('/shifts'),
    staleTime: REFERENCE_DATA_STALE_TIME,
  })
}

export function useSupervisors() {
  return useQuery({
    queryKey: ['supervisors', 'options'],
    queryFn: () => get<EmployeeSummary[]>('/employees/supervisors'),
    staleTime: REFERENCE_DATA_STALE_TIME,
  })
}

export function useManagers(enabled = true) {
  return useQuery({
    queryKey: ['managers', 'options'],
    queryFn: () => get<EmployeeSummary[]>('/employees/managers'),
    staleTime: REFERENCE_DATA_STALE_TIME,
    enabled,
  })
}

interface SelectorProps {
  value: string
  onChange: (value: string) => void
  id?: string
  includeAll?: boolean
  allLabel?: string
  disabled?: boolean
  required?: boolean
}

/** The query value for a multi-select filter: ids joined by commas, or nothing when none are picked. */
export function idsParam(ids: string[]): string | undefined {
  return ids.length > 0 ? ids.join(',') : undefined
}

interface MultiSelectOption {
  value: string
  label: string
}

/**
 * A dropdown of checkboxes for filters that take several values.
 *
 * Nothing picked means "all". The panel is drawn on <body> and placed from the
 * field's box, like EmployeeSelector's menu, so a card or modal that hides
 * overflow cannot clip it.
 */
export function MultiSelect({
  id,
  options,
  value,
  onChange,
  allLabel,
  searchPlaceholder = 'Search',
  disabled,
}: {
  id?: string
  options: MultiSelectOption[]
  value: string[]
  onChange: (values: string[]) => void
  allLabel: string
  searchPlaceholder?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({})
  const fieldRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const selected = useMemo(() => new Set(value), [value])
  const labelOf = useMemo(() => new Map(options.map((option) => [option.value, option.label])), [options])
  const picked = value.map((entry) => labelOf.get(entry)).filter((label): label is string => Boolean(label))
  const summary =
    picked.length === 0 ? allLabel : picked.length === 1 ? picked[0] : `${picked[0]} +${picked.length - 1} more`

  const term = search.trim().toLowerCase()
  const visible = term ? options.filter((option) => option.label.toLowerCase().includes(term)) : options

  useLayoutEffect(() => {
    if (!open) return undefined
    const place = (): void => {
      const field = fieldRef.current
      if (!field) return
      const box = field.getBoundingClientRect()
      const below = window.innerHeight - box.bottom - 12
      const above = box.top - 12
      const openUp = below < 220 && above > below
      setPanelStyle({
        left: Math.min(box.left, window.innerWidth - Math.max(box.width, 260) - 8),
        width: Math.max(box.width, 260),
        top: openUp ? 'auto' : box.bottom + 4,
        bottom: openUp ? window.innerHeight - box.top + 4 : 'auto',
        maxHeight: Math.max(160, Math.min(340, openUp ? above : below)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (fieldRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  const toggle = (option: string): void => {
    // Keep the options' own order rather than the order they were clicked in.
    const next = new Set(selected)
    if (next.has(option)) next.delete(option)
    else next.add(option)
    onChange(options.filter((entry) => next.has(entry.value)).map((entry) => entry.value))
  }

  return (
    <div className="multiselect" ref={fieldRef}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`input select multiselect-trigger${picked.length > 0 ? ' has-value' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        title={picked.length > 1 ? picked.join(', ') : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="multiselect-summary">{summary}</span>
        {picked.length > 1 ? <span className="multiselect-count">{picked.length}</span> : null}
      </button>
      {picked.length > 0 && !disabled ? (
        <button type="button" className="combobox-clear multiselect-clear" aria-label={`Clear: show ${allLabel.toLowerCase()}`} onClick={() => onChange([])}>
          <X size={14} />
        </button>
      ) : null}

      {open
        ? createPortal(
            <div className="multiselect-panel" ref={panelRef} style={panelStyle} role="group" aria-label={allLabel}>
              {options.length > 6 ? (
                <input
                  className="input multiselect-search"
                  type="search"
                  placeholder={searchPlaceholder}
                  value={search}
                  autoFocus
                  onChange={(event) => setSearch(event.target.value)}
                />
              ) : null}
              <div className="multiselect-actions">
                <span className="subtle">{picked.length === 0 ? 'None picked: showing all' : `${picked.length} selected`}</span>
                <span>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onChange(options.map((option) => option.value))}
                    disabled={selected.size === options.length}
                  >
                    Select all
                  </button>
                  <button type="button" className="link-button" onClick={() => onChange([])} disabled={selected.size === 0}>
                    Clear
                  </button>
                </span>
              </div>
              <div className="multiselect-options">
                {visible.map((option) => (
                  <label key={option.value} className={`multiselect-option${selected.has(option.value) ? ' is-selected' : ''}`}>
                    <input type="checkbox" checked={selected.has(option.value)} onChange={() => toggle(option.value)} />
                    <span>{option.label}</span>
                  </label>
                ))}
                {visible.length === 0 ? <p className="combobox-empty">Nothing matches that search.</p> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

/** Pick any number of departments; none picked means all of them. */
export function DepartmentMultiSelector({
  value,
  onChange,
  id,
  allLabel = 'All departments',
  disabled,
}: {
  value: string[]
  onChange: (ids: string[]) => void
  id?: string
  allLabel?: string
  disabled?: boolean
}) {
  const { data, isLoading } = useDepartments()
  const options = useMemo(
    () => (data ?? []).map((department) => ({ value: department.id, label: department.name })),
    [data],
  )
  return (
    <MultiSelect
      id={id}
      options={options}
      value={value}
      onChange={onChange}
      allLabel={allLabel}
      searchPlaceholder="Search departments"
      disabled={disabled || isLoading}
    />
  )
}

export function DepartmentSelector({ value, onChange, id, includeAll = true, allLabel = 'All departments', disabled, required }: SelectorProps) {
  const { data, isLoading } = useDepartments()
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || isLoading} required={required}>
      {includeAll ? <option value="">{allLabel}</option> : <option value="">Select a department</option>}
      {(data ?? []).map((department) => (
        <option key={department.id} value={department.id}>
          {department.name}
        </option>
      ))}
    </Select>
  )
}

export function DesignationSelector({ value, onChange, id, includeAll = true, allLabel = 'All sections', disabled }: SelectorProps) {
  const { data, isLoading } = useDesignations()
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || isLoading}>
      {includeAll ? <option value="">{allLabel}</option> : <option value="">Select a section</option>}
      {(data ?? []).map((designation) => (
        <option key={designation.id} value={designation.id}>
          {designation.name}
        </option>
      ))}
    </Select>
  )
}

export function EmployeeTypeSelector({ value, onChange, id, includeAll = true, allLabel = 'All types', disabled }: SelectorProps) {
  const { data, isLoading } = useEmployeeTypes()
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || isLoading}>
      {includeAll ? <option value="">{allLabel}</option> : <option value="">Select a type</option>}
      {(data ?? []).map((type) => (
        <option key={type.id} value={type.id}>
          {type.name}
        </option>
      ))}
    </Select>
  )
}

export function LocationSelector({ value, onChange, id, includeAll = true, allLabel = 'All locations', disabled }: SelectorProps) {
  const { data, isLoading } = useLocations()
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || isLoading}>
      {includeAll ? <option value="">{allLabel}</option> : <option value="">Select a location</option>}
      {(data ?? []).map((location) => (
        <option key={location.id} value={location.id}>
          {location.name}
        </option>
      ))}
    </Select>
  )
}

export function SupervisorSelector({ value, onChange, id, includeAll = true, allLabel = 'All supervisors', disabled }: SelectorProps) {
  const { data, isLoading } = useSupervisors()
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || isLoading}>
      {includeAll ? <option value="">{allLabel}</option> : <option value="">Select a supervisor</option>}
      {(data ?? []).map((supervisor) => (
        <option key={supervisor.id} value={supervisor.id}>
          {supervisor.fullName} ({supervisor.employeeCode})
        </option>
      ))}
    </Select>
  )
}

export function ManagerSelector({ value, onChange, id, includeAll = true, allLabel = 'All managers', disabled }: SelectorProps) {
  const { data, isLoading } = useManagers()
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || isLoading}>
      {includeAll ? <option value="">{allLabel}</option> : <option value="">No manager</option>}
      {(data ?? []).map((manager) => (
        <option key={manager.id} value={manager.id}>
          {manager.fullName} ({manager.employeeCode})
        </option>
      ))}
    </Select>
  )
}

export function LeaveTypeSelector({ value, onChange, id, includeAll = false, allLabel = 'All leave types', disabled, required }: SelectorProps) {
  const { data, isLoading } = useLeaveTypes()
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || isLoading} required={required}>
      {includeAll ? <option value="">{allLabel}</option> : <option value="">Select a leave type</option>}
      {(data ?? []).map((leaveType) => (
        <option key={leaveType.id} value={leaveType.id}>
          {leaveType.name} {leaveType.isPaid ? '' : '(unpaid)'}
        </option>
      ))}
    </Select>
  )
}

/**
 * Employee picker: one combobox field that searches by name or employee ID as
 * you type and lets you pick straight from the results, rather than a search
 * box paired with a separate select (plan section 58: stays usable with
 * thousands of employees since matching happens server-side).
 */
export function EmployeeSelector({
  value,
  onChange,
  id,
  placeholder = 'Search by name or employee ID',
  disabled,
  includeFormer = false,
}: {
  value: string
  onChange: (employeeId: string, employee?: EmployeeSummary) => void
  id?: string
  placeholder?: string
  disabled?: boolean
  /** Also list employees who have left, e.g. to issue a certificate or an old payslip. */
  includeFormer?: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({})
  const listboxId = `${id ?? 'employee-selector'}-listbox`

  const search = query.trim()

  const { data, isFetching } = useQuery({
    queryKey: ['employees', 'selector', search, includeFormer],
    queryFn: () =>
      getWithMeta<EmployeeSummary[]>('/employees', {
        search: search || undefined,
        pageSize: 20,
        employmentStatus: includeFormer ? undefined : 'ACTIVE',
      }),
    staleTime: 30_000,
    enabled: open,
  })

  // Resolves the label for a value set from outside (e.g. loading a form to
  // edit), so the field never shows a bare ID while the dropdown is closed.
  const { data: selectedEmployee } = useQuery({
    queryKey: ['employees', 'selector-selected', value],
    queryFn: () => get<EmployeeDetail>(`/employees/${value}`),
    enabled: Boolean(value) && !open,
    staleTime: 60_000,
  })

  const employees = useMemo(() => data?.data ?? [], [data])

  const selectedLabel = selectedEmployee ? `${selectedEmployee.employeeCode} — ${selectedEmployee.fullName}` : ''

  useEffect(() => {
    if (!open) setHighlighted(0)
  }, [open, employees.length])

  // The menu is drawn in a portal on <body>, positioned from the input's box, so
  // no ancestor can clip it: a modal body scrolls and hides overflow, which is
  // where an absolutely positioned menu used to disappear. It opens upwards when
  // there is more room above the field than below it.
  useLayoutEffect(() => {
    if (!open) return undefined

    const place = (): void => {
      const field = containerRef.current
      if (!field) return
      const box = field.getBoundingClientRect()
      const below = window.innerHeight - box.bottom - 12
      const above = box.top - 12
      const openUp = below < 180 && above > below
      setMenuStyle({
        left: box.left,
        width: box.width,
        top: openUp ? 'auto' : box.bottom + 4,
        bottom: openUp ? window.innerHeight - box.top + 4 : 'auto',
        maxHeight: Math.max(120, Math.min(260, openUp ? above : below)),
      })
    }

    place()
    window.addEventListener('resize', place)
    // Capture: the field may sit inside any scrolling container, not just the window.
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent): void {
      const target = event.target as Node
      // The menu lives outside the container (portal), so a click on it is not "outside".
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [])

  const selectEmployee = (employee: EmployeeSummary): void => {
    onChange(employee.id, employee)
    setQuery('')
    setOpen(false)
  }

  const clearSelection = (): void => {
    onChange('', undefined)
    setQuery('')
    setOpen(false)
  }

  // While closed and nothing is being typed, the field shows the resolved
  // label for the current value; while open, it shows what the user is typing.
  const displayValue = open ? query : value ? selectedLabel : query

  return (
    <div className="employee-selector combobox" ref={containerRef}>
      <div className="combobox-input-row">
        <input
          id={id}
          className="input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          autoComplete="off"
          value={displayValue}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
            if (value) onChange('', undefined)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false)
              return
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setHighlighted((index) => Math.min(index + 1, employees.length - 1))
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setHighlighted((index) => Math.max(index - 1, 0))
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              const employee = employees[highlighted]
              if (employee) selectEmployee(employee)
            }
          }}
        />
        {value && !open ? (
          <button
            type="button"
            className="combobox-clear"
            aria-label="Clear selected employee"
            disabled={disabled}
            onClick={clearSelection}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      {open
        ? createPortal(
            <ul
              className="combobox-menu combobox-menu-floating"
              id={listboxId}
              role="listbox"
              ref={menuRef}
              style={menuStyle}
            >
              {isFetching ? (
                <li className="combobox-empty">Searching…</li>
              ) : employees.length === 0 ? (
                <li className="combobox-empty">No matching employees</li>
              ) : (
                employees.map((employee, index) => (
                  <li
                    key={employee.id}
                    role="option"
                    aria-selected={employee.id === value}
                    className={`combobox-option${index === highlighted ? ' is-highlighted' : ''}`}
                    onMouseDown={(event) => {
                      // Prevent the input's blur (which would close the menu first).
                      event.preventDefault()
                      selectEmployee(employee)
                    }}
                    onMouseEnter={() => setHighlighted(index)}
                  >
                    <strong>{employee.employeeCode}</strong> — {employee.fullName}
                  </li>
                ))
              )}
            </ul>,
            document.body,
          )
        : null}
    </div>
  )
}

/**
 * Uploads one document to an employee.
 *
 * Type and size are checked before the request so obvious mistakes are caught
 * immediately; the server re-checks the real content type regardless
 * (plan section 52).
 */
const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png']
const MAX_SIZE_BYTES = 10 * 1024 * 1024

export function DocumentUploader({
  employeeId,
  category,
  onUploaded,
  label = 'Upload document',
}: {
  employeeId: string
  category: string
  onUploaded?: () => void
  label?: string
}) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSelect = (selected: File | null): void => {
    setError(null)
    if (!selected) {
      setFile(null)
      return
    }
    if (!ACCEPTED_TYPES.includes(selected.type)) {
      setError('Only PDF, JPG and PNG files are accepted')
      setFile(null)
      return
    }
    if (selected.size > MAX_SIZE_BYTES) {
      setError(`The file is ${formatFileSize(selected.size)}; the limit is 10 MB`)
      setFile(null)
      return
    }
    setFile(selected)
    if (!title) setTitle(selected.name.replace(/\.[^.]+$/, ''))
  }

  const handleUpload = async (): Promise<void> => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('category', category)
      formData.append('title', title || file.name)
      await upload(`/employees/${employeeId}/documents`, formData)
      setFile(null)
      setTitle('')
      onUploaded?.()
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="document-uploader">
      <div className="document-uploader-row">
        <label className="file-input">
          <Upload size={14} aria-hidden />
          <span>{file ? file.name : 'Choose a file'}</span>
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            onChange={(event) => handleSelect(event.target.files?.[0] ?? null)}
          />
        </label>
        <input
          className="input"
          type="text"
          value={title}
          placeholder="Document title"
          onChange={(event) => setTitle(event.target.value)}
          aria-label="Document title"
        />
        <Button onClick={handleUpload} loading={busy} disabled={!file}>
          {label}
        </Button>
      </div>
      {file ? <p className="field-message">{formatFileSize(file.size)} · PDF, JPG or PNG up to 10 MB</p> : null}
      {error ? (
        <p className="field-message field-message-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
