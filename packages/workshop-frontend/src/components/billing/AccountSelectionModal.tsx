import { useCallback, useEffect, useRef, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Dialog, Button, Loader, Radio, useKumoToastManager } from '@cloudflare/kumo'
import { Warning } from '@phosphor-icons/react'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { useCloudflareLimitsEnabled } from '../../ServerConfigContext'
import { useT } from '../../i18n/useT'
import { NATIVE_CONNECT_COMPLETE_EVENT } from '../../connectHandoff'

/**
 * Global, mandatory modal that forces the user to pick which Cloudflare account to bill whenever
 * they're connected but have access to more than one account. Auto-opens (and re-opens) as long as
 * the selection is pending, so it can't be missed after connecting. Mounted once in the app shell.
 */
export default function AccountSelectionModal() {
  const t = useT()
  const limitsEnabled = useCloudflareLimitsEnabled()
  const auth = useOptionalAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [needsSelection, setNeedsSelection] = useState(false)
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const refreshVersion = useRef(0)

  const check = useCallback(async (preserveChoice = false) => {
    if (!auth) return
    const version = ++refreshVersion.current
    setAccounts(null)
    if (!preserveChoice) setChosen(undefined)
    try {
      const u: CloudflareUsageInfo = await auth.authenticatedApi.getCloudflareUsage()
      if (version !== refreshVersion.current) return
      const needed = !!(u.connected && u.needsAccountSelection)
      setNeedsSelection(needed)
      if (!needed) return
      const list: CloudflareAccountOption[] = await auth.authenticatedApi.listCloudflareAccounts()
      if (version !== refreshVersion.current) return
      setAccounts(list)
      setChosen(previous => list.some(account => account.accountId === previous) ? previous : list[0]?.accountId)
    } catch {
      if (version === refreshVersion.current) setAccounts([])
    }
  }, [auth])

  useEffect(() => {
    if (!limitsEnabled || !auth) return
    check()
    // Focus is not a new connection: retain the user's choice if it is still available.
    const onFocus = () => { void check(true) }
    const onNativeComplete = () => { void check() }
    window.addEventListener('focus', onFocus)
    window.addEventListener(NATIVE_CONNECT_COMPLETE_EVENT, onNativeComplete)
    return () => {
      ++refreshVersion.current
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(NATIVE_CONNECT_COMPLETE_EVENT, onNativeComplete)
    }
  }, [limitsEnabled, auth, check])

  if (!limitsEnabled || !auth || !needsSelection) return null

  const save = async () => {
    if (!chosen) return
    setSaving(true)
    try {
      await auth.authenticatedApi.selectCloudflareAccount(chosen)
      toasts.add({ title: t('billing.accountSelected'), variant: 'success' })
      setNeedsSelection(false)
      setAccounts(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('billing.selectError')
      toasts.add({ title: msg, variant: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    // role="alertdialog" + no close affordance: the choice is mandatory, so it isn't dismissible by
    // clicking outside.
    <Dialog.Root open role="alertdialog">
      <Dialog className="responsive-dialog !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !-translate-y-0 flex-col overflow-hidden p-0 sm:w-[480px]" size="base">
        <div className="shrink-0 px-6 pt-6">
          <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
            <Warning size={22} weight="bold" className="text-kumo-warning" />
            {t('billing.selectTitle')}
          </Dialog.Title>
          <p className="text-sm text-kumo-subtle">
            {t('billing.selectDesc')}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {accounts === null ? (
            <div className="flex justify-center py-6"><Loader size="base" /></div>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-kumo-subtle">{t('billing.noAccounts')}</p>
          ) : (
            <Radio.Group
              appearance="card"
              value={chosen}
              onValueChange={setChosen}
              disabled={saving}
            >
              <Radio.Legend className="sr-only">{t('billing.cloudflareAccount')}</Radio.Legend>
              {accounts.map((a) => (
                <Radio.Item key={a.accountId} value={a.accountId} label={a.accountName} />
              ))}
            </Radio.Group>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line px-6 py-4">
          {accounts !== null && accounts.length === 0 ? (
            // Degenerate case: the connection reported multiple accounts but the list came back
            // empty (transient API failure, or access changed). Don't trap the user in an
            // un-actionable modal — let them retry or dismiss (it re-checks on focus).
            <>
              <Button variant="ghost" onClick={() => setNeedsSelection(false)}>
                {t('billing.discard')}
              </Button>
              <Button variant="secondary" onClick={() => { void check(true) }}>
                {t('billing.tryAgain')}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={save}
              loading={saving}
              disabled={accounts === null || !chosen || saving}
            >
              {t('billing.save')}
            </Button>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
