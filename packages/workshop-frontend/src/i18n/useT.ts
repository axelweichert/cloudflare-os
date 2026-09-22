// owlOS i18n overlay — translation hook. NOT present in upstream (FORK-SYNC.md §12).
import { useCallback } from 'react'
import { useI18n } from './I18nProvider'
import { en, type TKey } from './catalogs/en'
import { de } from './catalogs/de'

const CATALOGS = { en, de } as const

/**
 * `const t = useT(); t('sidebar.home')` — typed against the English key set.
 * Optional `{name}` placeholders are interpolated: t('theme.switchAction', { mode: 'Dark' }).
 * Falls back to the English string if a key is somehow missing from the active catalog.
 */
export function useT() {
  const { lang } = useI18n()
  return useCallback((key: TKey, params?: Record<string, string>) => {
    const raw = CATALOGS[lang][key] ?? en[key]
    if (!params) return raw
    return raw.replace(/\{(\w+)\}/g, (m, name) => params[name] ?? m)
  }, [lang])
}
