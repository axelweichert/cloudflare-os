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
- ✅ Verbindungen & Gatekeeper-Oberflächen (`routes/gatekeepers`, `routes/context`, `Connections`,
  `ConnectAccountModal`, `ConnectConnectorModal`, `GatekeeperModal`, `GatekeeperAppPage`, `ResourcePicker`,
  `ResourceConfiguratorHost`, `ObserverConfigModal`, `WorkpiecePicker`, `gatekeeper-modal/*`) — [VON-1893]
- ✅ Backend- & vonbusch-Gatekeeper-Nutzertexte (`workshop-backend/src` nutzersichtbare Strings,
  `gatekeeper-vonbusch-*/src/app-ui.ts`, `vonbusch/*`, `format-blueprints`) — [VON-1895]
- ✅ Einstellungen, Profil, Admin, Abrechnung & Modelle (`SettingsPage`, `routes/profile`,
  `routes/admin`, `AdminPage`, `routes/providers`, `AddModelModal`, `components/billing/*`,
  `ShareModal`, `AutoApproveConfirmDialog`, `HookToggle`, `DeleteConfirmationDialog`) — [VON-1894]
- ✅ Chat-/Agent-Tool-Oberfläche des Backends (`web-fetch.ts`-Fehlertexte, webFetch-Beobachtungskarte,
  `overseer.ts` `/compact`-Beschreibung, Fallback-Titel, `receiveExternalMessage`-Antworten) —
  [VON-1896]. Damit sind alle Frontend-Slices (App-Shell, Auth/Onboarding, Start/Chat/Arbeitsbereich,
  Gadget-Editor, Blueprints/Entdecken, Verbindungen/Gatekeeper, Einstellungen/Profil/Admin/Abrechnung)
  und die nutzersichtbaren Backend-/Gatekeeper-Texte erledigt.

### Anmerkungen zu [VON-1895]

- **Bereits deutsch (keine Änderung):** Alle fünf `gatekeeper-vonbusch-*/src/app-ui.ts` (CRM, Mail,
  Mailbox, Preiserhebung, Robomon) wurden von Anfang an auf Deutsch verfasst; ebenso die
  vonbusch-Blueprint-Gadgets (`vonbusch/format-blueprints/src/{angebot-erstellen,lead-qualifizieren}`
  client/server) und deren Sidecars `angebot-erstellen.json` / `lead-qualifizieren.json`.
- **Übersetzt:** Die drei Cloudflare-Default-Format-Blueprints, die im Deployment mitgebündelt werden
  (`FORMAT_BLUEPRINTS_DIR=vonbusch/format-blueprints`, ersetzt das Default-Set): `workspace-docs`,
  `workspace-sheets`, `workspace-slides`. `title`, `description` sowie `output.noun`/`output.plural`
  (letztere erscheinen als „Neu: {noun}" / „{noun} erstellen" / Outputs-Gruppierung) auf Deutsch:
  Dokument(e) / Tabelle(n) / Präsentation(en). `output.id` (`document`/`spreadsheet`/`presentation`)
  bleibt technischer Gruppierungsschlüssel.
- Das generierte Bundle `packages/workshop-backend/src/generated/format-blueprints.ts` ist
  gitignored und wird beim Build (`build:worker`) aus den Sidecars neu erzeugt — nur die
  `.json`-Sidecars werden committed. Die Kopien unter `packages/workshop-backend/format-blueprints/`
  sind das Upstream-Default-Set und werden vom Deployment NICHT genutzt; bewusst unangetastet, um die
  Merge-Fläche bei Upstream-Syncs klein zu halten.
- **Backend-Fehlermeldungen (nutzersichtbar) übersetzt.** Ausnahme zur Glossar-Regel „`throw new
  Error` = Dev-Diagnose": Das Backend läuft capnweb ohne `onSendError`-Override, d. h. geworfene
  `Error.message` werden zum Browser serialisiert, und das Frontend rendert `err.message` direkt als
  Toast/Banner (bestätigt in `LoginPage`/`SignupPage`/`OAuthButtons` → `setError(err.message)`,
  ebenso `ShareModal`, `AdminPage`, `SettingsPage`). Übersetzt wurden daher die nutzersichtbaren
  Validierungs-/Auth-Meldungen in: `auth/login-flow.ts` (Anmeldefehler), `server.ts` (Avatar-Upload,
  Passwort-Login/-Signup-Gates, Gatekeeper-Login), `user.ts` (Passwort/Registrierung, Modell-/
  Blueprint-/Konto-/Gatekeeper-Fehler, Benutzername-Validierung, „unavailable"-Vendor-Fallback),
  `sharing.ts` (Mitarbeiter-/Freigabe-Link-Fehler; die `action`-Verben `kopieren`/`bearbeiten`/
  `widerrufen` an den Call-Sites mitübersetzt, weil sie in den Satz interpoliert werden),
  `admin-settings.ts` (Längen-/Format-Meldungen), `site-logo.ts` (Logo-Validierung). „Deployment",
  „Blueprint", „Gatekeeper", „Gadget", „Avatar", „Cloudflare Access", „AI Gateway" bleiben als
  Produkt-/Eigennamen stehen.
- **Bewusst NICHT übersetzt:** `slash-commands.ts` (nur `console.error` + datengetriebene Labels der
  Gatekeeper), `agent-catalog.ts` (modellseitiger System-Prompt-Text + `logger.warn`),
  `client-errors.ts` HTTP-Status-Bodies (programmatisch, kein UI-Text); rein programmatische/
  defensive Invarianten-Throws (`"No such account."`, `"No such service"`, `"Blueprint not found."`
  u. ä.). `revision`-Felder der Sidecars NICHT gebumpt (Archiv-Bytes unverändert;
  `formatBlueprintsManifestVersion()` fingerprintet bereits title/description/output und löst die
  Neuinstallation aus).
- **Offen (Folgeaufgabe [VON-1896]):** Chat-/Agent-seitige Tool-Oberfläche — `agent.ts` Tool-`label`s
  (z. B. „Read file"), `web-fetch.ts` Tool-Fehlertexte, `overseer.ts` `/compact`-Beschreibung und
  Fallback-Titel, `external-message-gateway`-Antworten. Getrennt, weil pro String der Chat-Render-Pfad
  bestätigt und modellseitiger Schema-Text (Tool-`description`s) ausgeschlossen werden muss.

### Anmerkungen zu [VON-1896]

Ansatz dieser Aufgabe: **pro String den Chat-Render-Pfad im Frontend bestätigt**, bevor übersetzt
wurde (modellseitiger Schema-Text und reine Logs bleiben unangetastet).

- **Übersetzt (Render-Pfad bestätigt):**
  - `web-fetch.ts` Tool-Fehlertexte (`Ungültige URL`, `Nur https://-URLs …`, `URLs mit eingebetteten
    Zugangsdaten …`, Content-Signal-Meldung). Diese werden geworfen → in `agent.ts` `webFetch.execute`
    per `toolCallNotes.set(id, {error: toolErrorText(e)})` als `AiToolCall.error` persistiert und im
    Frontend in `ToolCallDetails` (rotes Fehler-Panel, `tc.error`) gerendert. Gleiche Ausnahme zur
    „`throw` = Dev-Diagnose"-Regel wie [VON-1895] (Fehler wird zum Browser serialisiert).
  - `agent.ts` webFetch-**Beobachtungskarte** (`recordAgentObservation`): `title` `Fetched {host}` →
    `Abgerufen: {host}` (konsistent mit dem Frontend-Verb „Abgerufen" aus `getToolCallSummary`),
    `resourceTitle` `Web fetch:` → `Web-Abruf:`, sowie die Beschreibungs-Klartexte (`(nicht angegeben)`,
    `Textkörper: … Zeichen`, `, gekürzt`). Gerendert in `ObservationDetails`
    (`log.description.title`/`.description` via `MarkdownMessage`) und `NestedObservationRow`. HTTP-Token
    (`GET`, `Status`, `Content-Type`, URL) bewusst belassen.
  - `overseer.ts` `/compact`-Beschreibung (`SlashCommandChoice.description`, gerendert im
    `SlashCommandPicker`/Befehlsmenü). Der Command-`name` `compact` (Slash-Token `/compact`) bleibt technisch.
  - `overseer.ts` Fallback-Titel `"(title unavailable)"` → `"(Titel nicht verfügbar)"` (7×) und
    `"(untitled resource)"` → `"(unbenannte Ressource)"` (1×) — beides `resourceTitle`-Platzhalter,
    die in Aktions-/Gatekeeper-/Beobachtungskarten sichtbar sind.
  - `overseer.ts` `receiveExternalMessage`-Ablehnungstexte (`SubmitExternalMessageResult.message`).
    Der Shared-Typ dokumentiert das Feld ausdrücklich als „User-facing explanation of an actionable
    submission rejection"; Zustellung erfolgt extern über den Chat-Gateway-Worker — Firmensprache DE.
- **Bewusst NICHT übersetzt (Render-Pfad widerlegt / modellseitig / Dev-Diagnose):**
  - `agent.ts` Tool-**`label`s** (`"Read file"`, `"Write file"`, …). Diese sind **nicht** im
    Live-Render-Pfad: die Chat-Tool-Call-Karten leiten ihre (bereits deutschen) Labels aus
    `getToolCallSummary(tc)` in `ChatInterface.tsx` ab, verschlüsselt über `tc.toolName` (erledigt in
    [VON-1890]). `AiToolCall` trägt gar kein `label`-Feld (Backend serialisiert es nie zum Client);
    `pi-agent-core` konsumiert das `AgentTool.label` nicht (kein Modell-Schema, keine UI). Die einzigen
    Komponenten, die `.label` lesen (`components/chat/ToolCallCard.tsx`, `ChatMessage.tsx`), sind
    Upstream-Demo-Bausteine, die aus Mock-Daten (`data/chat.ts`) gespeist werden — nicht die Live-App.
    Übersetzung wäre toter Aufwand → gemäß Auftrag zurückgestellt statt geraten.
  - `web-fetch.ts` `Fetch timed out after …ms` und `Markdown conversion failed: …` — technisch/
    diagnostisch geprägt, außerhalb der kuratierten Trace-Scope-Liste; belassen.
  - `external-message-gateway.ts` `"ExternalMessageGateway source prop is required."` — programmatische
    Konfig-Invariante (fehlendes Binding-Prop), keine Nutzer-Meldung.
  - Alle gepaarten `*_TOOL_DESCRIPTION`-Konstanten und Parameter-`description`s (modellseitiger
    Tool-Schema-Text) sowie `console.*`/Logs — unverändert.

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

### Anmerkungen zu [VON-1893]

- Produktbegriffe unübersetzt: `Gatekeeper`, `Gadget`, `Blueprint`, `Agent`, `App`, `Hook(s)`,
  `Deployment`, `Skill`, `Spawner` (Toolname). Umgebende Beschreibungstexte übersetzt.
  `connection`/`binding` → „Verbindung"; „AI Model" → „KI-Modell"; „Resource" → „Ressource";
  „Account" → „Konto"; „Configurator" → „Konfigurator".
- Ausnahmsweise übersetzt, weil der Fehlertext über `err.message`/`setError` direkt in einem
  UI-Banner bzw. Toast landet: `configuratorError`-Fallback und die `throw new Error(...)` in
  `GatekeeperModal.tsx` (Configurator not ready / no resource URL), die Banner-Fehler in
  `Connections.tsx` (`BlueprintAnnotationModal`) und `GatekeeperAppPage.tsx`, sowie die
  Duplikat-Meldung in `AgentSpawnerConfigForm.tsx`.
- Bewusst **nicht** übersetzt: alle `console.error`/`logRpcFailure`-Diagnosen; Datenwert-Vergleiche
  (`resourceTitle === 'Email Mailbox'`, `vendorId === 'email'`), `localStorage`-Keys, `variant`/
  `mode`/`kind`-Enum-Werte. Der `validateBindingName`-Fehler stammt aus `@gadgets/workshop-shared`
  (außerhalb Scope) und bleibt vorerst englisch.
- Ohne Änderung (keine statischen englischen Anzeige-Strings): `gatekeepers_.$appId.tsx`
  (nur `'App'`-Fallback), `ConnectionChips.tsx`, `ConnectionConfigField.tsx` („Optional" ist
  DE-identisch).

### Anmerkungen zu [VON-1894]

- Ansprache durchgehend „Du". Neue Begriffe: „Provider" → „Anbieter", „Quick model" →
  „Schnellmodell", „Site name" → „Website-Name", „Accent color" → „Akzentfarbe", „Sign-ups" →
  „Registrierungen", „Collaborator" → „Mitarbeiter", „Share link" → „Freigabelink", „Owner" →
  „Eigentümer", „Add credits" → „Guthaben aufladen". Produktbegriffe unübersetzt: `Blueprint`,
  `Gadget`, `Gatekeeper`, `Agent`, `App`, `Admin`, `Dashboard`, `Deployment`, `Hook`, `Markdown`,
  `AI Gateway`, `Workers AI`; Provider-Eigennamen (`Anthropic`, `OpenAI`, `Google`, `Ollama`).
- Enum-Werte bleiben technisch englisch, Anzeige über Label-Maps: neue `BANNER_LABELS` in
  `AdminPage.tsx` (`neutral`→„Neutral", `success`→„Erfolg", `warning`→„Warnung", `danger`→„Gefahr",
  `brand`→„Marke"); `ACCENT_PRESETS`-Labels lokalisiert, Hex-Werte unverändert.
- Ausnahmsweise übersetzt, weil direkt in UI (Toast/`setError`/Banner): `err.message`-Fallbacks in
  allen Handlern (`ShareModal`, `AdminPage`, `AddModelModal`, `providers`, `billing/*`), der
  `setPasswordError`-Fallback in `SettingsPage`, sowie der native `confirm(...)`-Text in
  `providers.tsx` (Provider löschen).
- Bewusst **nicht** übersetzt: der Dashboard-Navigationspfad im Cloudflare-API-Token-Hinweis
  (`AddModelModal.tsx` „Workers AI > Use REST API > …") ist ein wörtliches Zitat der
  Cloudflare-eigenen UI; alle `console.error`-Diagnosen; Enum-/Konfig-Werte (`themeMode`,
  `BannerColor`, `AmbientGatekeeperMode`, `CollaboratorRole`), `localStorage`/Query-Keys.
- `routes/profile.tsx` und `routes/admin.tsx` sind reine Route-Wrapper ohne Strings — in Scope,
  aber ohne Änderung. Kompakte Relativzeit in `ShareModal` als „vor X Min./Std./Tg.".
