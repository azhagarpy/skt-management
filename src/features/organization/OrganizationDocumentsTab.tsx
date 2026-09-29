import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Trash2, Upload } from 'lucide-react'
import { del, download, get, upload } from '../../lib/api'
import { formatDateTime, formatFileSize } from '../../lib/format'
import { useToast } from '../../app/providers/ToastProvider'
import { Button, Card, ConfirmDialog, Field, Input, Textarea } from '../../components/ui'
import { DataTable, type Column } from '../../components/tables/DataTable'
import type { OrganizationDocument } from '../../types/api'

const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png']
const MAX_SIZE_BYTES = 10 * 1024 * 1024

/**
 * Company documents - licences, registrations, agreements - kept against the
 * organization. The server re-checks the file's real type from its bytes.
 */
export function OrganizationDocumentsTab({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  // Remounts the file input after an upload so it shows empty again.
  const [inputKey, setInputKey] = useState(0)
  const [deleteTarget, setDeleteTarget] = useState<OrganizationDocument | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['organization', 'documents'],
    queryFn: () => get<OrganizationDocument[]>('/organization/documents'),
  })

  const uploadMutation = useMutation({
    mutationFn: () => {
      const formData = new FormData()
      formData.append('file', file as File)
      formData.append('title', title.trim())
      if (note.trim()) formData.append('note', note.trim())
      return upload('/organization/documents', formData)
    },
    onSuccess: async () => {
      toast.success('Document uploaded')
      setTitle('')
      setNote('')
      setFile(null)
      setInputKey((key) => key + 1)
      await queryClient.invalidateQueries({ queryKey: ['organization', 'documents'] })
    },
    onError: (mutationError: Error) => toast.error('Could not upload the document', mutationError.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (document: OrganizationDocument) => del(`/organization/documents/${document.id}`),
    onSuccess: async () => {
      toast.success('Document deleted')
      setDeleteTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['organization', 'documents'] })
    },
    onError: (mutationError: Error) => {
      setDeleteTarget(null)
      toast.error('Could not delete the document', mutationError.message)
    },
  })

  // Obvious mistakes are caught here; the server re-checks the real bytes.
  const handleSelect = (selected: File | null): void => {
    setFileError(null)
    setFile(null)
    if (!selected) return
    if (!ACCEPTED_TYPES.includes(selected.type)) {
      setFileError('Only PDF, JPG and PNG files are accepted')
      return
    }
    if (selected.size > MAX_SIZE_BYTES) {
      setFileError(`The file is ${formatFileSize(selected.size)}; the limit is 10 MB`)
      return
    }
    setFile(selected)
    if (!title) setTitle(selected.name.replace(/\.[^.]+$/, ''))
  }

  const downloadDocument = async (document: OrganizationDocument): Promise<void> => {
    setDownloading(document.id)
    try {
      await download(`/organization/documents/${document.id}/file`, document.originalFilename)
    } catch (downloadError) {
      toast.error('Download failed', downloadError instanceof Error ? downloadError.message : undefined)
    } finally {
      setDownloading(null)
    }
  }

  const columns: Column<OrganizationDocument>[] = [
    {
      key: 'title',
      header: 'Title',
      render: (row) => (
        <div>
          <strong>{row.title}</strong>
          {row.note ? <p className="subtle" style={{ whiteSpace: 'pre-line' }}>{row.note}</p> : null}
        </div>
      ),
    },
    {
      key: 'file',
      header: 'File',
      render: (row) => (
        <div>
          <span>{row.originalFilename}</span>
          <p className="subtle">{formatFileSize(row.fileSizeBytes)}</p>
        </div>
      ),
    },
    {
      key: 'uploaded',
      header: 'Uploaded',
      hideOnMobile: true,
      render: (row) => (
        <div>
          <span>{formatDateTime(row.createdAt)}</span>
          {row.uploadedByName ? <p className="subtle">{row.uploadedByName}</p> : null}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div className="row" style={{ gap: '0.4rem', justifyContent: 'flex-end' }}>
          <Button
            size="sm"
            variant="ghost"
            icon={<Download size={13} />}
            loading={downloading === row.id}
            onClick={() => void downloadDocument(row)}
          >
            Download
          </Button>
          {canManage ? (
            <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setDeleteTarget(row)}>
              Delete
            </Button>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div className="stack">
      {canManage ? (
        <Card title="Upload a document" description="Licences, registrations, agreements and other company papers. PDF, JPG or PNG up to 10 MB.">
          <div className="stack">
            <div className="grid grid-2">
              <Field label="Title" htmlFor="org-document-title" required>
                <Input
                  id="org-document-title"
                  value={title}
                  maxLength={160}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
              <Field label="File" htmlFor="org-document-file" required error={fileError ?? undefined}>
                <label className="file-input">
                  <Upload size={14} aria-hidden />
                  <span>{file ? `${file.name} (${formatFileSize(file.size)})` : 'Choose a file'}</span>
                  <input
                    key={inputKey}
                    id="org-document-file"
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png"
                    onChange={(event) => handleSelect(event.target.files?.[0] ?? null)}
                  />
                </label>
              </Field>
            </div>
            <Field label="Note" htmlFor="org-document-note" hint="Optional - for example the licence number or its renewal date.">
              <Textarea
                id="org-document-note"
                rows={3}
                value={note}
                maxLength={1000}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
            <div>
              <Button
                icon={<Upload size={15} />}
                loading={uploadMutation.isPending}
                disabled={!file || title.trim().length < 2}
                onClick={() => uploadMutation.mutate()}
              >
                Upload
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card title="Organization documents" padded={false}>
        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(row) => row.id}
          loading={isFetching}
          error={error}
          onRetry={() => void refetch()}
          emptyTitle="No documents yet"
          caption="Organization documents"
        />
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete document"
        message={`Delete "${deleteTarget?.title}"? The file is removed permanently.`}
        confirmLabel="Delete"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
