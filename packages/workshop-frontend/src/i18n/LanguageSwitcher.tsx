// owlOS i18n overlay — DE/EN toggle. NOT present in upstream (FORK-SYNC.md §12).
// Mounted in AppShell next to the connection chip. Shows the active locale; clicking flips it.
// setLang persists to localStorage and re-renders live via I18nProvider (no page reload).
import { Tooltip } from '@cloudflare/kumo'
import { useI18n } from './I18nProvider'

export default function LanguageSwitcher() {
  const { lang, setLang } = useI18n()
  const next = lang === 'de' ? 'en' : 'de'
  const label = next === 'en' ? 'Switch to English' : 'Zu Deutsch wechseln'

  return (
    <Tooltip
      content={label}
      render={(
        <button
          type="button"
          aria-label={label}
          onClick={() => setLang(next)}
          className="flex h-8 min-w-8 cursor-pointer items-center justify-center rounded-md px-1.5 text-xs font-semibold text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated"
        >
          {lang.toUpperCase()}
        </button>
      )}
    />
  )
}
