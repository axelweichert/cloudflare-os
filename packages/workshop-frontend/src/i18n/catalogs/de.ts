// owlOS i18n overlay — German catalog. NOT present in upstream (FORK-SYNC.md §12).
//
// Typed as Record<TKey, string> against en.ts, so a missing/renamed key is a
// compile error. DE is the default language (I18nProvider).
import type { TKey } from './en'

export const de: Record<TKey, string> = {
  'appshell.mainNav': 'Hauptnavigation',
  'appshell.openMenu': 'Menü öffnen',
  'appshell.closeMenu': 'Menü schließen',

  'sidebar.aside': 'Seitenleiste',
  'sidebar.search': 'Suche',
  'sidebar.searchTitle': 'Suche (⌘K)',
  'sidebar.collapse': 'Seitenleiste einklappen',
  'sidebar.expand': 'Seitenleiste ausklappen',
  'sidebar.home': 'Start',
  'sidebar.workspaces': 'Arbeitsbereiche',
  'sidebar.blueprints': 'Baupläne',
  'sidebar.outputs': 'Ergebnisse',
  'sidebar.explore': 'Entdecken',
  'sidebar.gatekeepers': 'Torwächter',

  'theme.system': 'System',
  'theme.light': 'Hell',
  'theme.dark': 'Dunkel',
  'theme.currentSystem': 'Erscheinungsbild: System ({resolved})',
  'theme.current': 'Erscheinungsbild: {mode}',
  'theme.switchAction': 'Zu {mode} wechseln.',

  'lang.label': 'Sprache',

  'auth.signInTitle': 'Melde dich bei deinem Konto an',
  'auth.username': 'Benutzername',
  'auth.usernamePlaceholder': 'dein-benutzername',
  'auth.password': 'Passwort',
  'auth.signIn': 'Anmelden',
  'auth.noAccount': 'Noch kein Konto?',
  'auth.createAccount': 'Konto erstellen',
  'auth.or': 'oder',
  'auth.invalidCredentials': 'Benutzername oder Passwort ist ungültig',
  'auth.signInFailed': 'Anmeldung fehlgeschlagen',
  'auth.configLoadError': 'Bereitstellungs-Einstellungen konnten nicht geladen werden.',
  'auth.reload': 'Neu laden',
  'auth.serverUnreachable': 'Server nicht erreichbar. Neuer Versuch …',
  'auth.loading': 'Wird geladen …',
}
