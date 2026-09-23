import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save } from 'lucide-react'
import { get, put } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { useToast } from '../../app/providers/ToastProvider'
import { Badge, Button, Card, Field, Input, PageHeader, Spinner } from '../../components/ui'
import { isStandalone, unregisterServiceWorker } from '../../lib/pwa'

interface Setting {
  id: string
  category: string
  key: string
  value: unknown
  description: string | null
  updatedAt: string
}

/**
 * System settings.
 *
 * Settings are free-form key/value pairs per category, so an organization can
 * record its own operational rules without a schema change. Statutory rates and
 * payroll policy live in their own screens rather than here, because payroll
 * reads them directly.
 */
export default function SettingsPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { can, user } = useAuth()

  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => get<Setting[]>('/organization/settings'),
  })

  const mutation = useMutation({
    mutationFn: () => {
      const settings = Object.entries(drafts).map(([composite, value]) => {
        const [category, key] = composite.split('::')
        let parsed: unknown = value
        // A setting may legitimately hold a number, boolean or object.
        try {
          parsed = JSON.parse(value)
        } catch {
          parsed = value
        }
        return { category: category ?? 'general', key: key ?? composite, value: parsed }
      })
      return put('/organization/settings', { settings })
    },
    onSuccess: async () => {
      toast.success('Settings saved')
      setDrafts({})
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (error: Error) => toast.error('Could not save settings', error.message),
  })

  if (isLoading) return <Spinner label="Loading settings" />

  const settings = data ?? []
  const categories = new Map<string, Setting[]>()
  for (const setting of settings) {
    const list = categories.get(setting.category) ?? []
    list.push(setting)
    categories.set(setting.category, list)
  }

  const valueOf = (setting: Setting): string => {
    const key = `${setting.category}::${setting.key}`
    if (key in drafts) return drafts[key] as string
    return typeof setting.value === 'string' ? setting.value : JSON.stringify(setting.value)
  }

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        description="Operational settings for this organization."
        actions={
          can('settings.manage') && Object.keys(drafts).length > 0 ? (
            <Button icon={<Save size={15} />} loading={mutation.isPending} onClick={() => mutation.mutate()}>
              Save {Object.keys(drafts).length} change(s)
            </Button>
          ) : null
        }
      />

      {categories.size === 0 ? (
        <Card title="No settings yet">
          <p className="muted">
            Nothing has been configured. Payroll policies and statutory rates are managed under Salary, and calendar rules
            under Calendar.
          </p>
        </Card>
      ) : (
        [...categories.entries()].map(([category, entries]) => (
          <Card key={category} title={category.charAt(0).toUpperCase() + category.slice(1)}>
            <div className="stack">
              {entries.map((setting) => (
                <Field
                  key={setting.id}
                  label={setting.key}
                  htmlFor={setting.id}
                  hint={setting.description ?? `Last changed ${formatDateTime(setting.updatedAt)}`}
                >
                  <Input
                    id={setting.id}
                    value={valueOf(setting)}
                    disabled={!can('settings.manage')}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [`${setting.category}::${setting.key}`]: event.target.value }))
                    }
                  />
                </Field>
              ))}
            </div>
          </Card>
        ))
      )}

      <Card title="This device" description="How the application is running here.">
        <div className="stack">
          <div className="breakdown-row">
            <span className="muted">Signed in as</span>
            <span>
              {user?.email} <Badge tone="info">{user?.role}</Badge>
            </span>
          </div>
          <div className="breakdown-row">
            <span className="muted">Installed as an app</span>
            <span>{isStandalone() ? 'Yes' : 'No, running in a browser tab'}</span>
          </div>
          <div className="breakdown-row">
            <span className="muted">Offline shell</span>
            <span>{'serviceWorker' in navigator ? 'Supported' : 'Not supported by this browser'}</span>
          </div>
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await unregisterServiceWorker()
                toast.info('Offline cache cleared', 'Reload the page to fetch the latest version.')
              }}
            >
              Clear offline cache
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
