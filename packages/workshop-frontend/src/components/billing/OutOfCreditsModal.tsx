import { useCallback, useEffect, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Dialog, Button, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { CloudWarning, Lightning } from '@phosphor-icons/react'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { buildAddCreditsUrl } from './creditsUrl'
import ResetCountdown from './ResetCountdown'

interface OutOfCreditsModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Modal shown when a user has exhausted their free daily allowance. Guides them to connect their
 * Cloudflare account (if not connected), pick which account to bill (if they have several), or top
 * up credits in the Cloudflare dashboard (if connected but low balance).
 */
export default function OutOfCreditsModal({ open, onClose }: OutOfCreditsModalProps) {
  const auth = useOptionalAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [usage, setUsage] = useState<CloudflareUsageInfo | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!auth) return
    auth.authenticatedApi.getCloudflareUsage()
      .then((u: CloudflareUsageInfo) => setUsage(u))
      .catch(() => {})
  }, [auth])

  useEffect(() => {
    if (!open || !auth) return
    setUsage(null)
    setAccounts(null)
    refresh()
    // Re-check when the tab regains focus, so returning from the "Connect Cloudflare" OAuth pop-up
    // updates the modal (connected state / balance / account list) without reopening it.
    const onFocus = () => {
      setAccounts(null)
      refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [open, auth, refresh])

  // Load the account list when the server says the user must pick one.
  useEffect(() => {
    if (!auth) return
    if (usage?.connected && usage.needsAccountSelection && accounts === null) {
      auth.authenticatedApi.listCloudflareAccounts()
        .then((list: CloudflareAccountOption[]) => setAccounts(list))
        .catch(() => setAccounts([]))
    }
  }, [auth, usage, accounts])

  const connect = async () => {
    if (!auth) return
    setConnecting(true)
    try {
      const { url } = await auth.authenticatedApi.connectAccount('cloudflare', [])
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      // ignore
    } finally {
      setConnecting(false)
    }
  }

  const selectAccount = async (accountId: string) => {
    if (!auth) return
    setSelecting(accountId)
    try {
      await auth.authenticatedApi.selectCloudflareAccount(accountId)
      setAccounts(null)
      refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Konto konnte nicht ausgewählt werden'
      toasts.add({ title: msg, variant: 'error' })
    } finally {
      setSelecting(null)
    }
  }

  const connected = usage?.connected ?? false
  const needsSelection = connected && (usage?.needsAccountSelection ?? false)

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="responsive-dialog overflow-y-auto p-6 sm:w-[560px]" size="base">
        <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
          <CloudWarning size={22} weight="bold" className="text-kumo-warning" />
          Du hast dein kostenloses Nutzungslimit erreicht
        </Dialog.Title>

        {usage === null ? (
          <div className="flex justify-center py-8"><Loader size="base" /></div>
        ) : (
          <div className="space-y-4">
            {!connected ? (
              <p className="text-sm text-kumo-subtle">
                Du hast heute alle {usage.dailyLimit} deiner kostenlosen {usage.dailyLimit === 1 ? 'Anfrage' : 'Anfragen'}
                {' '}verbraucht. Verbinde jetzt dein Cloudflare-Konto, um weiterzubauen — Nutzung über das
                kostenlose Kontingent hinaus wird über dein eigenes Cloudflare-AI-Gateway-Guthaben abgerechnet
                {usage.resetAt ? (
                  <>
                    {' '}— oder warte: deine kostenlosen {usage.dailyLimit === 1 ? 'Anfrage wird' : 'Anfragen werden'} um
                    00:00 UTC zurückgesetzt, in <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} />.
                  </>
                ) : '.'}
              </p>
            ) : needsSelection ? (
              <p className="text-sm text-kumo-subtle">
                Deine Cloudflare-Verbindung hat Zugriff auf mehrere Konten. Wähle aus, dessen
                AI-Gateway-Guthaben für die Nutzung über das kostenlose Kontingent hinaus
                abgerechnet werden soll.
              </p>
            ) : (
              <p className="text-sm text-kumo-subtle">
                Dein Cloudflare-Konto ist verbunden
                {usage.balance !== null && (
                  <> mit einem Guthaben von <strong>${usage.balance.toFixed(2)}</strong></>
                )}
                , liegt aber unter dem für die Fortsetzung nötigen Mindestbetrag. Lade Guthaben in
                deinem AI Gateway auf, um jetzt weiterzubauen
                {usage.resetAt ? (
                  <>
                    {' '}oder warte — deine kostenlosen {usage.dailyLimit === 1 ? 'Anfrage wird' : 'Anfragen werden'} um
                    00:00 UTC zurückgesetzt, in <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} />.
                  </>
                ) : '.'}
              </p>
            )}

            {needsSelection && (
              <div className="flex flex-col gap-2">
                {accounts === null ? (
                  <p className="text-sm text-kumo-subtle">Konten werden geladen …</p>
                ) : accounts.length === 0 ? (
                  <p className="text-sm text-kumo-subtle">Für diese Verbindung sind keine Konten verfügbar.</p>
                ) : (
                  accounts.map((a) => (
                    <Button
                      key={a.accountId}
                      variant="secondary"
                      className="justify-start"
                      onClick={() => selectAccount(a.accountId)}
                      loading={selecting === a.accountId}
                      disabled={selecting !== null}
                    >
                      {a.accountName}
                    </Button>
                  ))
                )}
              </div>
            )}

            <p className="text-sm text-kumo-subtle">
              Mehr über{' '}
              <a
                href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                die einheitliche AI-Gateway-Abrechnung
              </a>{' '}
              erfahren.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2">
              {!connected ? (
                <>
                  <Button variant="secondary" onClick={onClose}>Vielleicht später</Button>
                  <Button variant="primary" onClick={connect} loading={connecting}>
                    <Lightning size={16} weight="bold" />
                    Cloudflare verbinden
                  </Button>
                </>
              ) : needsSelection ? (
                <Button variant="secondary" onClick={onClose}>Schließen</Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={onClose}>Schließen</Button>
                  <Button
                    variant="primary"
                    onClick={() => window.open(buildAddCreditsUrl(usage.accountId), '_blank')}
                  >
                    Guthaben in Cloudflare aufladen
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
