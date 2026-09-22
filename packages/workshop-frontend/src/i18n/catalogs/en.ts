// owlOS i18n overlay — NOT present in upstream (see vonbusch/FORK-SYNC.md §12).
//
// The English catalog is the SOURCE OF TRUTH for the key set: `TKey` is derived
// from it, so every other catalog (de.ts) must supply exactly these keys or the
// typecheck fails. Flat `namespace.key` → string maps; no plural machinery.
//
// `{name}` placeholders are interpolated by useT(key, { name }). Keep them because
// word order differs across languages (e.g. "Switch to Dark." vs "Zu Dunkel wechseln.").
export const en = {
  // AppShell chrome (upstream file — see FORK-SYNC.md touched-files list)
  'appshell.mainNav': 'Main navigation',
  'appshell.openMenu': 'Open menu',
  'appshell.closeMenu': 'Close menu',

  // Sidebar (upstream files: Sidebar.tsx, SidebarUtilityStrip.tsx)
  'sidebar.aside': 'Sidebar',
  'sidebar.search': 'Search',
  'sidebar.searchTitle': 'Search (⌘K)',
  'sidebar.collapse': 'Collapse sidebar',
  'sidebar.expand': 'Expand sidebar',
  'sidebar.home': 'Home',
  'sidebar.workspaces': 'Workspaces',
  'sidebar.blueprints': 'Blueprints',
  'sidebar.outputs': 'Outputs',
  'sidebar.explore': 'Explore',
  'sidebar.gatekeepers': 'Gatekeepers',

  // Theme toggle (SidebarUtilityStrip.tsx)
  'theme.system': 'System',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.currentSystem': 'Appearance: System ({resolved})',
  'theme.current': 'Appearance: {mode}',
  'theme.switchAction': 'Switch to {mode}.',

  // Language switcher (overlay component)
  'lang.label': 'Language',

  // Auth / login screen (LoginPage.tsx)
  'auth.signInTitle': 'Sign in to your account',
  'auth.username': 'Username',
  'auth.usernamePlaceholder': 'your-username',
  'auth.password': 'Password',
  'auth.signIn': 'Sign in',
  'auth.noAccount': 'No account yet?',
  'auth.createAccount': 'Create account',
  'auth.or': 'or',
  'auth.invalidCredentials': 'Invalid username or password',
  'auth.signInFailed': 'Sign in failed',
  'auth.configLoadError': 'Deployment settings could not be loaded.',
  'auth.reload': 'Reload',
  'auth.serverUnreachable': 'Server unreachable. Retrying …',
  'auth.loading': 'Loading …',
} as const

export type TKey = keyof typeof en
