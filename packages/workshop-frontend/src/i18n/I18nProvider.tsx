// owlOS i18n overlay — provider. NOT present in upstream (FORK-SYNC.md §12).
// Mirrors ThemeContext.tsx / FeatureFlagsContext.tsx: createContext + localStorage,
// no react-i18next dependency (CTO decision, OWL-1591). Default language: DE.
import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type Lang = 'de' | 'en'

const STORAGE_KEY = 'gadgets:lang'
const DEFAULT_LANG: Lang = 'de'

function readLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : DEFAULT_LANG
  } catch {
    return DEFAULT_LANG
  }
}

interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang)

  const value = useMemo<I18nContextValue>(() => ({
    lang,
    setLang: (next) => {
      try { localStorage.setItem(STORAGE_KEY, next) } catch {}
      setLangState(next)
    },
  }), [lang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used within I18nProvider')
  return context
}
