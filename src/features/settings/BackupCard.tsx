import { useState } from 'react'
import { DatabaseBackup } from 'lucide-react'
import { download } from '../../lib/api'
import { useToast } from '../../app/providers/ToastProvider'
import { Button, Card } from '../../components/ui'

/** YYYYMMDD-HHmmss in local time, matching the name the server gives the file. */
function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Downloads one zip holding the whole database and every uploaded file. The
 * server builds it on request, so it is always current; it holds every
 * employee's personal and salary data, which the card says plainly.
 */
export function BackupCard() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const runBackup = async (): Promise<void> => {
    setBusy(true)
    try {
      await download('/backup', `skt-backup-${timestamp(new Date())}.zip`)
      toast.success('Backup downloaded', 'Keep the file somewhere safe - it contains every employee record.')
    } catch (error) {
      toast.error('Backup failed', error instanceof Error ? error.message : undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Backup" description="Download a complete copy of this system's data as one zip file.">
      <div className="stack">
        <ul className="subtle" style={{ margin: 0, paddingLeft: '1.1rem' }}>
          <li>The whole database - employees, attendance, leave, salary, payroll, payments and settings.</li>
          <li>Every uploaded file - employee documents and photos, payment proofs, organization documents and the logo.</li>
          <li>A README with restore steps. Server secrets (the .env file) are not included.</li>
        </ul>
        <div className="alert alert-info">
          The backup holds Aadhaar, PAN, bank and salary details for every employee. Store it somewhere secure and do not
          share it.
        </div>
        <div>
          <Button icon={<DatabaseBackup size={15} />} loading={busy} onClick={() => void runBackup()}>
            {busy ? 'Preparing backup...' : 'Download backup'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
