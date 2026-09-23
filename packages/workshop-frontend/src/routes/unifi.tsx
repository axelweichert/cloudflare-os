import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { ArrowsClockwise, WifiHigh, Broadcast, Warning } from '@phosphor-icons/react'
import ViewToggle from '../components/ViewToggle'
import { EmptyState } from '../components/EmptyState'
import { useAuthenticatedApi } from '../AuthContext'
import { useDocumentTitle } from '../useDocumentTitle'
import { useT } from '../i18n/useT'
import { logRpcFailure } from '../rpcErrors'
import type { UnifiInventory, UnifiSiteView } from '@gadgets/workshop-shared/api'

export const Route = createFileRoute('/unifi')({
  component: UnifiDashboard,
})

const UNIFI_BRAND = '#0559C9'

// Traffic-light colours for a site's rolled-up status. Concrete hex (not Kumo tokens) so the
// warning/offline state is guaranteed to render in a clear colour regardless of theme (DoD #3).
const STATUS_COLOR: Record<UnifiSiteView['status'], string> = {
  ok: '#16a34a',
  warning: '#d97706',
  offline: '#dc2626',
}

const STATUS_LABEL_KEY = {
  ok: 'routes.unifi.status.ok',
  warning: 'routes.unifi.status.warning',
  offline: 'routes.unifi.status.offline',
} as const

function UnifiDashboard() {
  const t = useT()
  useDocumentTitle(t('routes.unifi.title'))
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()

  const [inventory, setInventory] = useState<UnifiInventory | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setLoadError(false)

    authenticatedApi
      .getUnifiInventory()
      .then((inv) => {
        if (cancelled) return
        setInventory(inv)
        setLoaded(true)
      })
      .catch((err) => {
        logRpcFailure('Failed to load UniFi inventory:', err)
        if (!cancelled) {
          setLoadError(true)
          setLoaded(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [authenticatedApi, refreshTick])

  const sites = useMemo(() => inventory?.sites ?? [], [inventory])
  const sectionGridClass =
    view === 'list' ? 'flex flex-col gap-2' : 'grid gap-3 sm:grid-cols-2'

  const problemCount = sites.filter((s) => s.status !== 'ok').length

  return (
    <div className="h-full overflow-y-auto bg-kumo-base">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 sm:py-14">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl text-white"
              style={{ backgroundColor: UNIFI_BRAND }}
            >
              <WifiHigh size={22} weight="bold" />
            </span>
            <div>
              <h1 className="m-0 text-3xl font-semibold leading-tight tracking-tight text-kumo-default sm:text-[34px]">
                {t('routes.unifi.title')}
              </h1>
              <p className="mt-1 text-[14px] leading-[20px] font-normal tracking-[-0.25px] text-kumo-subtle">
                {t('routes.unifi.subtitle')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setRefreshTick((n) => n + 1)}
            title={t('routes.unifi.refresh')}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-base px-3 text-[13px] font-medium text-kumo-subtle transition-colors hover:text-kumo-default"
          >
            <ArrowsClockwise size={15} />
            {t('routes.unifi.refresh')}
          </button>
        </header>

        {/* Summary + view toggle */}
        {loaded && !loadError && inventory?.connected && sites.length > 0 && (
          <div className="mb-6 flex items-center justify-between gap-3">
            <p className="m-0 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle">
              {t('routes.unifi.summary', {
                sites: String(sites.length),
                hosts: String(inventory.hostCount),
              })}
              {problemCount > 0 && (
                <span className="ml-2 font-semibold" style={{ color: STATUS_COLOR.warning }}>
                  {t('routes.unifi.problemCount', { count: String(problemCount) })}
                </span>
              )}
            </p>
            <ViewToggle view={view} onChange={setView} />
          </div>
        )}

        {/* Loading */}
        {!loaded && (
          <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-10 text-center text-[13px] text-kumo-subtle">
            {t('routes.unifi.loading')}
          </div>
        )}

        {/* RPC failure */}
        {loaded && loadError && (
          <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-6 text-center">
            <p className="m-0 text-[13px] font-medium tracking-[-0.25px] text-kumo-danger">
              {t('routes.unifi.loadError')}
            </p>
            <button
              type="button"
              onClick={() => setRefreshTick((n) => n + 1)}
              className="mt-3 text-[13px] font-medium text-kumo-brand hover:underline"
            >
              {t('routes.unifi.retry')}
            </button>
          </div>
        )}

        {/* UniFi read failed server-side (e.g. key rejected) */}
        {loaded && !loadError && inventory?.error && (
          <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-6 text-center">
            <Warning size={22} className="mx-auto mb-2" style={{ color: STATUS_COLOR.warning }} />
            <p className="m-0 text-[13px] font-medium tracking-[-0.25px] text-kumo-default">
              {t('routes.unifi.readError')}
            </p>
            <p className="mt-1 text-[12px] leading-4 text-kumo-subtle">{inventory.error}</p>
          </div>
        )}

        {/* Not connected */}
        {loaded && !loadError && inventory && !inventory.connected && (
          <EmptyState
            icon={WifiHigh}
            title={t('routes.unifi.notConnectedTitle')}
            description={t('routes.unifi.notConnectedBody')}
            actionLabel={t('routes.unifi.connect')}
            onAction={() => navigate({ to: '/gatekeepers' })}
          />
        )}

        {/* Credentials expired */}
        {loaded && !loadError && inventory?.connected && inventory.credentialsExpired && (
          <EmptyState
            icon={Warning}
            title={t('routes.unifi.expiredTitle')}
            description={t('routes.unifi.expiredBody')}
            actionLabel={t('routes.unifi.reconnect')}
            onAction={() => navigate({ to: '/gatekeepers' })}
          />
        )}

        {/* Connected but no sites */}
        {loaded &&
          !loadError &&
          inventory?.connected &&
          !inventory.credentialsExpired &&
          !inventory.error &&
          sites.length === 0 && (
            <EmptyState
              icon={Broadcast}
              title={t('routes.unifi.emptyTitle')}
              description={t('routes.unifi.emptyBody')}
            />
          )}

        {/* Sites grid */}
        {sites.length > 0 && (
          <div className={sectionGridClass}>
            {sites.map((site) => (
              <SiteCard key={`${site.hostId}:${site.siteId}`} site={site} t={t} view={view} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SiteCard({
  site,
  t,
  view,
}: {
  site: UnifiSiteView
  t: ReturnType<typeof useT>
  view: 'grid' | 'list'
}) {
  const color = STATUS_COLOR[site.status]
  const statusLabel = t(STATUS_LABEL_KEY[site.status])

  return (
    <div
      className={`themed-card-hover-shadow group rounded-2xl border border-kumo-line bg-kumo-base p-4 ${
        view === 'list' ? 'flex items-center gap-4' : ''
      }`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className="mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="m-0 truncate text-[15px] font-semibold tracking-[-0.25px] text-kumo-default">
              {site.name}
            </h3>
            <span
              className="flex-shrink-0 rounded-full px-2 py-[2px] text-[11px] font-semibold"
              style={{ backgroundColor: `${color}1a`, color }}
            >
              {statusLabel}
            </span>
          </div>
          {site.hostName && (
            <p className="mt-0.5 truncate text-[12px] text-kumo-subtle">{site.hostName}</p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-kumo-subtle">
            <span>
              <span className="font-semibold text-kumo-default">{site.deviceOnline}</span>
              {site.deviceTotal > 0 ? `/${site.deviceTotal}` : ''}{' '}
              {t('routes.unifi.devicesOnline')}
            </span>
            {site.deviceOffline > 0 && (
              <span style={{ color: STATUS_COLOR.warning }}>
                {t('routes.unifi.devicesOffline', { count: String(site.deviceOffline) })}
              </span>
            )}
            {!site.hostOnline && (
              <span style={{ color: STATUS_COLOR.offline }}>{t('routes.unifi.hostOffline')}</span>
            )}
            {(site.isp || site.wan) && (
              <span className="inline-flex items-center gap-1">
                <Broadcast size={13} />
                {[site.isp, site.wan].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
