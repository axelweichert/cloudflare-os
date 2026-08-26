# Deutsche Lokalisierung des Cloudflare OS (von Busch Digital)

Dieses Dokument hält die verbindliche Terminologie und das Vorgehen für die
Übersetzung der **nutzerseitigen Texte** des Cloudflare OS ins Deutsche fest
(Board-Issue [VON-1888], Elternaufgabe [VON-1887]).

## Ansatz (CTO-Entscheidung)

Wir betreiben einen Fork (`axelweichert/cloudflare-os`) und wollen **Deutsch als
Standardsprache** der Oberfläche — kein Multi-Locale-Runtime-Switching. Es gibt im
Upstream **kein i18n-Framework**; alle Strings sind hartkodiert (React/TSX,
`aria-label`, `title`, `placeholder`, Toasts, Dialog-Copy).

**Entscheidung:** Direkte Ersetzung der englischen Strings durch deutsche Strings am
Fundort. Kein zusätzlicher `t()`-Layer / Message-Katalog. Begründung:

- Kein Multi-Locale-Bedarf → ein Message-Katalog bringt nur Indirektion ohne Nutzen.
- Ein `t()`-Layer, den der Upstream nicht kennt, vergrößert die Merge-Konflikt-Fläche
  bei jedem Upstream-Sync zusätzlich; die reine String-Ersetzung bleibt zeilennah.
- Terminologie-Konsistenz wird stattdessen über dieses Glossar sichergestellt.

Bei künftigen Upstream-Merges neu hinzugekommene englische Strings werden nach dem
Glossar nachgezogen.

## Was übersetzt wird

- Sichtbare Labels, Buttons, Menüeinträge, Überschriften
- `aria-label`, `title`, `alt`, `placeholder` (Barrierefreiheit ist nutzerseitig)
- Fehlermeldungen und Toasts, die dem Nutzer angezeigt werden
- Nutzerorientierte Onboarding-/Hilfetexte, Beispiel-Prompts

## Was NICHT übersetzt wird (Firmen-Sprachregel)

- Code-Identifier, Variablen-/Funktionsnamen, Typnamen, Enum-**Werte**
  (z. B. `themeMode: 'system' | 'light' | 'dark'` bleibt als Wert englisch — nur das
  angezeigte Label wird lokalisiert)
- API-Endpoints, Toolnamen, CLI-Flags, Konfig-Keys
- Technische Logs / `console.error` / `throw new Error(...)` (Entwickler-Diagnose)
- Wörtliche Zitate / Lizenztexte aus englischsprachigen Upstream-Quellen

## Glossar (verbindlich)

| Englisch            | Deutsch                          | Anmerkung                                  |
| ------------------- | -------------------------------- | ------------------------------------------ |
| Home                | Start                            | Primär-Navigation                          |
| Workspace(s)        | Arbeitsbereich(e)                |                                            |
| Recent workspaces   | Zuletzt verwendet                |                                            |
| Untitled workspace  | Unbenannter Arbeitsbereich       |                                            |
| Outputs             | Ergebnisse                       |                                            |
| Explore             | Entdecken                        |                                            |
| Search              | Suche / durchsuchen              |                                            |
| Favorite (Verb)     | favorisieren / zu Favoriten …    | Substantiv: Favoriten                      |
| Share               | Teilen                           |                                            |
| Rename              | Umbenennen                       |                                            |
| Delete / Remove     | Löschen / Entfernen              | „Remove" = aus eigener Liste nehmen        |
| Sign out            | Abmelden                         |                                            |
| Profile             | Profil                           |                                            |
| Providers           | Anbieter                         | Modell-/LLM-Anbieter                       |
| Settings            | Einstellungen                    |                                            |
| Theme               | Erscheinungsbild                 | Modi: System / Hell / Dunkel               |
| Command palette     | Befehlspalette                   |                                            |
| Actions             | Aktionen                         |                                            |
| Get started         | Erste Schritte                   |                                            |
| Collapse / Expand   | Einklappen / Ausklappen          |                                            |
| Show all            | Alle anzeigen                    |                                            |
| No results / matches| Keine Ergebnisse / Keine Treffer |                                            |
| Sign in             | Anmelden                         | Auch Dokumenttitel/Button                  |
| Create account      | Konto erstellen                  |                                            |
| Username            | Benutzername                     |                                            |
| Password            | Passwort                         | Confirm Password → Passwort bestätigen     |
| Continue with       | Weiter mit                       | OAuth-/Gatekeeper-Button                    |
| Display name        | Anzeigename                      |                                            |
| Model               | Modell                           | KI-/AI-Modell                              |
| Connect / Connected | Verbinden / Verbunden            | Connecting… → Wird verbunden …             |
| Back / Next         | Zurück / Weiter                  | Onboarding-Navigation                      |
| Loading…            | Wird geladen …                   |                                            |
| Retry               | Erneut versuchen                 |                                            |

### Als Produktbegriffe unübersetzt (Eigennamen)

`Blueprint`, `Gadget`, `Gatekeeper`, `Workflow`, `Admin`, `Dashboard`, `App`.
Umgebende Beschreibungstexte werden aber übersetzt.

### Stil

- Ansprache: **Du** (informell, konsistent mit dem internen Produktcharakter).
- Auslassungspunkte als echtes Ellipsis-Zeichen `…`.
- Deutsche Anführungszeichen `„…"` in Fließtexten.

## Fortschritt

- ✅ App-Shell & Navigation (`components/AppShell/*`, `UserMenu`, Befehlspalette,
  Start-Beispielaufgaben) — [VON-1888]
- ✅ Authentifizierung & Onboarding (`LoginPage`, `SignupPage`, `OnboardingWizard`,
  `components/auth/*`, `AnnouncementBanner`, `ProtectedRoute`) — [VON-1889]
- ✅ Gadget-Editor, Code & Formate (`GadgetEditor`, `GadgetCodeInterface`, `CodeEditor`,
  `CodeDiffEditor`, `GadgetExportMenu`, `components/format/*`) — [VON-1891]
- ✅ Start, Chat & Arbeitsbereich (`routes/index`, `ChatInterface`, `components/chat/*`,
  `GadgetUI`, `GadgetUseView`, `Activity`, `ActivityNotifications`, `FileSidebar`,
  `routes/outputs`, `routes/workspaces`, `RecentApps`) — [VON-1890]
- ✅ Blueprints & Entdecken (`routes/blueprints`, `routes/explore`, `BlueprintsPage`,
  `BlueprintLandingPage`, `BlueprintModal`, `components/Blueprint{Card,List,BindingCard,PreviewImage}`,
  `VendorCard`) — [VON-1892]
- ⏳ Restliche Oberflächen: siehe Kind-Issues unter [VON-1888].

### Anmerkungen zu [VON-1891]

- `Diff` bleibt als Fachbegriff stehen (Layout-Labels: „Gestapeltes Diff" / „Geteiltes Diff").
- Dynamische `{noun}`-Konstruktionen (z. B. „New Doc") sind nicht genusflektierbar; Buttons als
  „{noun} erstellen", reine Anzeige-Pills/-Titel als „Neu {noun}".
- Bewusst **nicht** übersetzt (kein reines Anzeige-Label): `AdminFormatsPanel.tsx` Zeile ~385
  spiegelt wörtlich den an das Modell gesendeten Prompt-Text (Backend `overseer.ts`
  `#listStandardFormats`); der `DiffStatus`-Wert (`Modified`/`Added`/…) in `CodeDiffEditor.tsx`
  wird per `===` verglichen — Lokalisierung erfordert ein Anzeige-Mapping (Folgeaufgabe, außerhalb
  Scope).

### Anmerkungen zu [VON-1892]

- `Blueprint`, `Gadget`, `Gatekeeper` und `Workshop` bleiben als Produktbegriffe stehen; die
  Explore-Route heißt in der UI „Entdecken" (Route-Pfad `/explore` bleibt technisch).
- `connection`/`binding` → „Verbindung"; „AI Model" → „KI-Modell", „Agent" bleibt.
- Der `throw new Error("… is not configured.")` in `BlueprintLandingPage` wird ausnahmsweise
  übersetzt, weil er über `setError` direkt im Fehler-Banner der UI landet (kein reines
  Dev-Diagnose-Throw).
- `VendorCard.tsx` enthält keine statischen englischen Strings (alle Labels datengetrieben) —
  in Scope, aber ohne Änderung.
