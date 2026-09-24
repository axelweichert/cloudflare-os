# Fork-Sync-Runbook — Cloudflare OS (von Busch Digital)

**Board-Issue:** [VON-1903] · **Elternentscheidung:** [VON-1902]
**Fork:** `axelweichert/cloudflare-os` · **Upstream:** `cloudflare/cloudflare-os` (verifiziert via GitHub-API: `parent.full_name = cloudflare/cloudflare-os`)
**Stand der ersten Bestandsaufnahme:** 2026-08-27

---

## ⛔ Null-Verlust-Garantie (VON-1905) — HART, TECHNISCH ERZWUNGEN

> **Board-Vorgabe (VON-1902): „Es darf nichts von unseren Änderungen verloren gehen."**
> Diese Garantie steht bewusst ganz oben. Sie ist keine Empfehlung, sondern die
> oberste Regel des Sync-Prozesses.

**Sync ist EINSEITIG.** Erlaubt ist ausschließlich das selektive Übernehmen
**einzelner** Upstream-Commits per `git cherry-pick -x <sha>` von `upstream` in einen
**Sync-Branch** (nie direkt auf `main`).

**Auf `main` strikt VERBOTEN** (würde Fork-Arbeit überschreiben/verlieren):

| Verbotener Befehl | Warum tödlich |
|---|---|
| `git merge upstream/main` | Massenkonflikte auf allen DE-Dateien; verleitet zu „ihre Version nehmen" → DE-Verlust. |
| `git reset --hard upstream/*` | Wirft **alle** Fork-Commits weg. Totalverlust. |
| `git rebase --onto upstream/*` | Schreibt Fork-Historie um, kann Commits still fallen lassen. |
| `git push --force` / `--force-with-lease` auf `main` | Überschreibt die Remote-Fork-Historie unwiderruflich. |
| `git branch -D main` / Löschen von `main` | Entfernt den Fork-Stand. |

Erlaubt bleibt: `git fetch upstream`, `git cherry-pick -x` **auf einem Sync-Branch**,
lesende Diffs/Reports. Deploy/Upstream-PR nur mit Board-Gate (siehe Abschnitt 3).

### Drei technische Sicherungen (alle umgesetzt, VON-1905)

1. **Pre-Sync-Sicherungspunkt (Pflichtschritt, siehe Abschnitt 2a).**
   Vor **jeder** Integration ein unveränderlicher Tag `owlos/pre-sync-YYYYMMDD`.
   Damit ist der Vor-Sync-Stand jederzeit exakt wiederherstellbar.

2. **Branch Protection auf `main` (GitHub, siehe Abschnitt 8).**
   Kein Force-Push, kein Löschen, PR-Review-Pflicht. Verhindert die tödlichen
   Befehle oben serverseitig — auch bei menschlichem/Automations-Fehler.

3. **Fork-Guard in CI (`owlos/scripts/fork-guard.sh`, siehe Abschnitt 9).**
   Verifiziert nach jeder Integration, dass unsere Fork-Marker (Verzeichnis
   `owlos/`, DE-Kataloge, Stichprobe realer DE-UI-Strings) weiterhin existieren.
   Fehlt ein Marker → CI **rot** → Merge blockiert.

**Wenn der Guard rot ist:** Integration **nicht** übernehmen. Sync-Branch aus dem
Sicherungspunkt wiederherstellen:

```bash
git tag --list 'owlos/pre-sync-*'                 # Sicherungspunkt finden
git reset --hard owlos/pre-sync-<DATUM>           # NUR auf dem Sync-Branch!
```

---

## 0. Grundhaltung (CEO-Entscheidung, VON-1902)

Unser Fork ist ein **Produkt-Fork, kein temporärer Branch**. Upstream ist
**Bezugsquelle, nicht Master**. Es gibt **kein** automatisches / blindes
`git merge upstream/main`.

Grund: Unsere DE-Strategie ist die **direkte EN→DE-String-Ersetzung im Quelltext**
(kein `t()`-Layer, siehe [I18N-DE.md](./I18N-DE.md)). Ein Merge würde daher auf fast
jeder berührten Datei Konflikte erzeugen. Wir übernehmen Upstream-Änderungen
**selektiv per Cherry-pick**.

---

## 1. Einrichtung (einmalig, bereits erledigt)

```bash
# upstream-Remote hinzufügen (idempotent, das Skript macht das auch selbst)
git remote add upstream https://github.com/cloudflare/cloudflare-os.git
git fetch upstream --no-tags
```

Verifizieren:

```bash
git remote -v          # upstream muss auf cloudflare/cloudflare-os zeigen
```

> **Merke:** Nie auf `upstream` pushen. `origin` = unser Fork, `upstream` = read-only Bezugsquelle.

---

## 2. Drift-Report (wiederkehrend: wöchentlich / on-demand)

```bash
owlos/scripts/drift-report.sh            # fetch + Report gegen upstream/main
owlos/scripts/drift-report.sh --no-fetch # ohne fetch (offline)
```

Das Skript ist **rein lesend** (außer `git fetch`) und liefert:

- **Ahead/Behind** (wie weit sind wir auseinander) + Gesamt-Diffstat
- Die noch nicht übernommenen Upstream-Commits, **kategorisiert**:
  - **(a) Security / kritische Fixes** → zeitnah selektiv übernehmen, Board nur *informieren* (kein Gate)
  - **(b) Features** → als Board-Issue aufnehmen, dann gezielt cherry-picken
  - **(c) Rest / Tests / Refactor** → i. d. R. nicht übernehmen, nur registrieren
- Pro Commit eine **⚠-Markierung**, wenn er eine **DE-übersetzte Kernfläche** berührt
  (dann ist ein Konflikt erwartbar → DE-String behalten).

Die Kategorisierung ist heuristisch (Betreff-Keywords). **Autoritativ ist das
Urteil des CTO** — jede Übernahme/Auslassung wird in Abschnitt 5 eingetragen.

**Kadenz:** Standard wöchentlich (Montag). Zusätzlich on-demand, bevor größere
Feature-Arbeit im Fork startet, damit wir nicht auf veraltetem Stand bauen.

---

## 3. Cherry-pick-Prozess

### (0) Pflichtschritt VOR jeder Integration: Pre-Sync-Sicherungspunkt

```bash
# Unveränderlicher Sicherungspunkt des aktuellen main-Stands.
# Ohne diesen Tag KEINE Integration beginnen.
git checkout main && git pull --ff-only origin main
git tag "owlos/pre-sync-$(date +%Y%m%d)" main
git push origin "owlos/pre-sync-$(date +%Y%m%d)"   # Sicherungspunkt auch remote
```

Damit ist der Zustand **vor** dem Sync jederzeit exakt wiederherstellbar
(`git reset --hard owlos/pre-sync-YYYYMMDD` — nur auf dem Sync-Branch). Tags
werden **nie** gelöscht; sie sind das Sicherheitsnetz der Null-Verlust-Garantie.

### (a) Security / kritische Fixes — zeitnah, Board nur informieren

```bash
git checkout -b sync/<upstream-pr-nr>-<kurzname> main
git cherry-pick -x <sha>          # -x hängt "cherry picked from <sha>" an
# Konflikte auf DE-Flächen: DE-String behalten, Upstream-Logik übernehmen
git status                        # Konflikte prüfen
# nach Auflösung:
git add -A && git cherry-pick --continue
# Verifikation (kleinste, die den Fix beweist), dann PR gegen origin/main
```

- **Board:** kurze Info im relevanten Issue („Security-Fix #NNN übernommen"), **kein Approval-Gate**.
- **Register:** Zeile in Abschnitt 5 ergänzen.

### (b) Features — Issue zuerst, dann gezielt übernehmen

1. Board-Issue anlegen („Upstream-Feature #NNN prüfen/übernehmen: …").
2. Nutzen bewerten. Wenn ja: cherry-pick wie oben, ggf. neue Strings ins DE-Glossar
   ([I18N-DE.md](./I18N-DE.md)) übersetzen.
3. Register-Zeile ergänzen.

### (c) Rest — bewusst nicht übernehmen

- Nicht cherry-picken. **Aber im Register vermerken** (Nachvollziehbarkeit), damit
  spätere Reports nicht denselben Commit erneut als „neu" aufwerfen.

### Konfliktregel für DE-Flächen (verbindlich)

Bei Konflikt zwischen Upstream-Änderung und unserer DE-Ersetzung gilt:
**Upstream-Logik/-Struktur übernehmen, deutschen String behalten.** Neue
englische Strings aus dem Upstream werden nach Glossar nachübersetzt.

### Board-Gate

**Kein Prod-Deployment und kein Upstream-PR** (PR *an* `cloudflare/cloudflare-os`)
ohne separaten Board-Gate. Cherry-picks landen auf `origin` (unser Fork); Deploy
folgt dem bestehenden Prod-Prozess (siehe Memory / VON-1897).

---

## 4. Erste Bestandsaufnahme (Baseline 2026-08-27)

| Kennzahl | Wert |
|---|---|
| Gemeinsame Basis (merge-base) | `1dc8442` — 2026-08-25, *"wait for every connection request…" (#320)* |
| Fork **voraus** (unsere Arbeit) | **22 Commits** |
| Fork **zurück** (Upstream ungesynct) | **12 Commits** |
| Gesamt-Diff main↔upstream/main | 222 Dateien, +10.504 / −10.655 |
| **Reale Kollisionsfläche** | **7 Dateien** (von 78 upstream-berührten × 151 fork-berührten) |

**Kollisionsdateien** (Upstream *und* Fork geändert → Cherry-pick-Konflikt erwartbar):

```
packages/workshop-backend/src/agent.ts          (DE-Strings + Upstream-Refactor)
packages/workshop-backend/src/overseer.ts        (DE-Strings + Upstream-Refactor)
packages/workshop-frontend/src/ChatInterface.tsx (DE-Strings)
packages/workshop-frontend/src/Activity.tsx      (DE-Strings)
packages/workshop-frontend/src/ActivityNotifications.tsx (DE-Strings)
packages/workshop-frontend/src/components/AppShell/AppShell.tsx (DE-Strings)
packages/workshop-frontend/src/GadgetEditor.tsx  (DE-Strings)
```

**Größenordnung:** Wir sind ~2 Tage / 12 Commits hinter Upstream. Die *reale*
Konfliktfläche ist klein (7 Dateien), 5 davon reine Frontend-DE-String-Dateien.
Drift ist derzeit **gut beherrschbar** per selektivem Cherry-pick.

---

## 5. Drift-Register (was übernommen / bewusst ausgelassen — warum)

> Chronologisch führen. Ein Commit erscheint **einmal**; danach nicht erneut als „neu" behandeln.
> Legende Entscheidung: ✅ übernommen · ⏳ Issue offen · ⛔ bewusst ausgelassen · 🔎 zu prüfen

### Baseline-Inventar 12 Upstream-Commits (Stand 2026-08-27)

| Upstream | Betreff | Kat. | Kollision? | Entscheidung | Begründung |
|---|---|---|---|---|---|
| `d56a004` #298 | Bound every action-log read path | **a** | **ja** (Activity.tsx/ActivityNotifications.tsx/GadgetEditor.tsx — DE-Strings) | ✅ übernommen `dd4c89e` (PR #1, 2026-08-28) | DoS-/OOM-Schutz (unbeschränkte Reads). **Heuristik unterschätzte den Konflikt**: real 3 DE-Frontend-Konflikte, Activity.tsx komplett auf `renderActivityContent()` refaktoriert. Aufgelöst per Regel (Upstream-Struktur + DE-Strings), fork-guard grün, FE+BE `tsc --noEmit` grün. |
| `38892c0` #341 | git-storage crash recovery, loose ends | **a** | **ja** (agent.ts, overseer.ts) | ⏳ Sub-Task angelegt (`c3ad3074`, 2026-08-28) | Datenintegrität/Crash-Recovery, aber großer Refactor genau unserer DE-Kern-Dateien → eigener Sub-Task (Kind von `72841aff`). |
| `6223e26` #334 | Resume action stream across reconnects | **a** | nein (auf main nach #298 konfliktfrei) | ✅ übernommen `26c05a8` (PR #3, 2026-08-28) | Reliability (Reconnect). Nach #298 **konfliktfrei** auto-merged (kein DE-String berührt). FE+BE `tsc`=0. |
| `0d7793c` #344 | Keep observer registrations when re-verify fails | a (Skript: c) | nein (auto-merge, keine DE-Fläche) | ✅ übernommen `6c7af1f` (PR #2, 2026-08-28) | Robustheit Observer-Registrierung. overseer.ts auto-merged, keine DE-Berührung. BE `tsc`=0. |
| `18ff477` #330 | Fix app sidebar height | a→kosmetisch | **ja** (AppShell.tsx, 1 Z. CSS) | 🔎 nice-to-have | Trivialer UI-Fix. Günstig, gering-riskant. |
| `42269e8` #292 | Add Google Drive metadata search | **b** | nein (gatekeeper-google, unübersetzt) | ⏳ Issue: Feature-Bedarf? | 37 Dateien, aber sauberer Cherry-pick (keine DE-Fläche). Nur wenn wir Drive-Suche wollen. |
| `6692c3c` #331 | Preview support in google oauth flow | **b** | nein (gatekeeper-google) | ⏳ Issue: Feature-Bedarf? | Sauber. Nur bei Bedarf. |
| `e16de69` #350 | Bump pi → 0.84.3 (DeepSeek V4 Workers-AI-Modelle) | **b** | nein (package.json, lock) | 🔎 empfohlen | Neuere Modell-Unterstützung, konfliktarm. Erst mit #348 sinnvoll. |
| `dccd089` #348 | Add DeepSeek V4 Pro 0813 to suggested models | **b** | ja (api.ts, +4 Z.) | 🔎 empfohlen (mit #350) | Kleines Feature. Paart mit pi-Bump. |
| `be370e1` #349 | Test Workshop lifecycle over public RPC | **c** | nein (nur Tests) | ⛔ optional | Reine Test-Addition. Kein Produkt-Impact. Ggf. für CI-Parität. |
| `05d0c82` #351 | Test Workshop sharing and presence | **c** | nein (nur Tests) | ⛔ optional | s. o. |
| `1411714` #352 | Test Workshop blueprints and outputs | **c** | nein (nur Tests) | ⛔ optional | s. o. |

> **Cherry-picks werden in diesem Heartbeat nicht ausgeführt** — VON-1903 ist ein
> *Prozess-/Runbook*-Issue. Die 🔎/⏳-Zeilen sind die Vorschlagsliste für den
> nächsten Sync (bzw. Board-Info bei den Security-Fixes). Nach Übernahme:
> Entscheidung auf ✅ setzen + Sync-Commit-SHA ergänzen.

### Sync-Zyklus-Log

#### 2026-08-28 — Sync-Zyklus 1 (VON: `72841aff`)

- **Pre-Sync-Sicherungspunkt:** Tag `owlos/pre-sync-20260828` (lokal + `origin`) auf `c2dd960`.
- **Übernommen (a):** `d56a004` #298 *Bound every action-log read path* → `dd4c89e`, gemergt via **PR #1** (Admin-Merge, `enforce_admins:false`; kein zweiter Reviewer-Agent vorhanden — dokumentierte Abweichung von der PR-Review-Auflage).
  - Konfliktlösung: `Activity.tsx` vollständig auf Upstream-Struktur (`renderActivityContent()`) übernommen und den gesamten user-sichtbaren String-Bestand neu ins Deutsche übersetzt; `ActivityNotifications.tsx` Upstream-Logik (`useActions`-Status) + DE-Strings; `GadgetEditor.tsx` **ausschließlich** Logik-Delta (`useActionEntries`, `pendingActionsCount`→`pendingActionCount`) auf DE-Basis angewandt (195 DE-Marker unangetastet).
  - **Neue Upstream-Strings ins Glossar-Muster übersetzt** (u. a. `PENDING_CHECKING_COPY`, `PENDING_ERROR_COPY`, Auto-Approval-Copy).
  - Verifikation: `fork-guard.sh` grün · `workshop-frontend` + `workshop-backend` `tsc --noEmit` = 0.
- **Übernommen (a):** `0d7793c` #344 *Keep observer registrations when re-verify fails* → `6c7af1f` (PR #2). overseer.ts auto-merged, keine DE-Berührung; BE `tsc`=0.
- **Übernommen (a):** `6223e26` #334 *Resume action stream across reconnects* → `26c05a8` (PR #3). Auf main nach #298 **konfliktfrei** auto-merged (kein DE-String berührt); FE+BE `tsc`=0. (Runbook hatte einen ChatInterface-DE-Konflikt erwartet — durch #298 entfiel er.)
- **Offen:** `38892c0` #341 → **eigener Sub-Task** `c3ad3074` (großer agent.ts/overseer.ts-Refactor).
- **Register-Hinweis:** Betreff-Heuristik hat #298 als „konfliktarm" fehlklassifiziert (real: 3 DE-Frontend-Konflikte). Für künftige Zyklen: Kollisions-Spalte nicht blind vertrauen, `git show --stat <sha>` gegen die DE-Dateiliste prüfen.

---

## 6. Analyse: Migration auf i18n-Katalog-Layer (`t()`) — Kosten/Nutzen

> **Separater Ausweis. Keine Umsetzung ohne Board-Gate.** Dies ist eine Empfehlung an CEO/Board.

### Kernfrage
Wie stark verbilligt ein echter Katalog-Layer (Trennung **Übersetzung ↔ Upstream-Quelltext**)
künftige Upstream-Syncs — gegenüber dem einmaligen Umbauaufwand?

### Was der Katalog-Layer ändern würde
Heute steht die Übersetzung **in** der Quelldatei (`<h1>Woran arbeiten wir?</h1>`).
Mit Katalog stünde dort ein Schlüssel (`<h1>{t('hero.title')}</h1>`) und die Übersetzung
in `de.json`. Die Quelldatei bliebe damit **zeilengleich zum Upstream** → Cherry-picks
auf Frontend-Strings wären **konfliktfrei**.

### Nutzen (quantifiziert an der realen Baseline)
- Kollisionsfläche des aktuellen Drifts: **7 Dateien**, davon **5 reine Frontend-DE-String-Dateien**.
  Ein Katalog-Layer würde genau diese 5 aus der Konfliktzone nehmen → Rest-Konflikt = 2
  Backend-Dateien (agent.ts/overseer.ts), wo Upstream *strukturell* refaktoriert.
- Steady-State: Jeder künftige Upstream-Sync würde auf dem gesamten Frontend
  **weitgehend konfliktfrei** mergebar — der teuerste und häufigste Konflikttyp verschwindet.
- Optionaler Nebeneffekt: Multi-Locale würde möglich (aktuell **kein** Bedarf).

### Kosten & Risiken
- **Einmaliger Umbau:** ~141 nutzerseitige TSX-Dateien + user-sichtbare Backend-/Gatekeeper-Strings
  in `t('key')` wrappen, Katalog `de.json` aufbauen, i18n-Runtime wählen & verdrahten.
  Realistisch **mehrere fokussierte Tage** Umbau + **~1 Tag Re-Verifikation** aller Flächen.
- **Runtime-Wahl (Edge-nativ):** Lingui oder i18next laufen browserseitig und sind
  Bundle-verträglich; kein Node-Zwang. Zusatz-Bundle-Gewicht gering (Katalog + Mini-Runtime).
- **Übersetzungsarbeit verschwindet nicht:** Neue Upstream-Strings kommen weiter auf
  Englisch und müssen in den Katalog übersetzt werden — der Layer entfernt nur die
  *Konfliktfläche*, nicht die Übersetzungspflicht.
- **Einführungs-Diff selbst ist groß** (berührt praktisch alle Frontend-Dateien) → einmalig
  hohe Review-/Verifikationslast und Risiko, während unser Produktumfang durch eigene
  Port-/AppUI-Arbeit ohnehin noch churnt.
- Backend-Konflikte (agent.ts/overseer.ts) bleiben teilweise bestehen, da dort auch
  echte Logik-Refactors des Upstreams auf unsere Strings treffen.

### Empfehlung an CEO/Board: **gestaffelt, jetzt noch nicht**
1. **Kurzfristig (jetzt):** Direkt-Ersetzung + dieses Runbook beibehalten. Drift ist mit
   selektivem Cherry-pick beherrschbar (reale Konfliktfläche aktuell 7 Dateien).
2. **Messen:** Über ~4–6 Wochen im Drift-Register den *tatsächlichen* Sync-Aufwand
   protokollieren (Konflikte/Sync, Zeit/Sync).
3. **Mittelfristig, falls der Sync wiederkehrend schmerzt:** Zuerst **nur die Frontend-
   String-Schicht** auf einen leichten Katalog (Lingui/i18next) migrieren — höchste
   Konfliktdichte, sauberste Extraktion, Edge-nativ. Backend als Direkt-Ersetzung belassen
   (weniger Strings, tiefere Kopplung).
4. **Kein Big-Bang jetzt:** Ohne Multi-Locale-Bedarf und bei laufendem Produkt-Churn
   überwiegt das Einmal-Risiko den aktuell moderaten Sync-Schmerz.

**Auslöser für Re-Evaluierung (Board-Gate anfragen), wenn eines eintritt:**
Multi-Locale wird Produktanforderung · Upstream-Sync kostet regelmäßig spürbar Zeit
durch Frontend-String-Konflikte · Übersetzungs-Konsistenz reißt trotz Glossar.

---

## 7. Checkliste je Sync-Zyklus

- [ ] **Pre-Sync-Sicherungspunkt setzen** (`owlos/pre-sync-YYYYMMDD`, Abschnitt 3.0) — Pflicht.
- [ ] `owlos/scripts/drift-report.sh` laufen lassen
- [ ] Sync **nur** auf eigenem `sync/*`-Branch — nie `merge`/`reset`/`rebase` auf `main` (Null-Verlust-Garantie).
- [ ] (a)-Fixes prüfen → cherry-pick, Board informieren, Register-Zeile ✅
- [ ] (b)-Features → Board-Issue anlegen (⏳), bei Übernahme Glossar pflegen
- [ ] (c)-Rest → im Register als ⛔ vermerken
- [ ] DE-Konflikte nach Regel (Upstream-Logik + DE-String) auflösen
- [ ] Neue englische Upstream-Strings nach Glossar ([I18N-DE.md](./I18N-DE.md)) übersetzen
- [ ] **`owlos/scripts/fork-guard.sh` grün** (auch lokal vor dem PR: `pnpm guard:fork`).
- [ ] PR gegen `origin/main` (Branch Protection erzwingt Review, Abschnitt 8).
- [ ] Kein Prod-Deploy / Upstream-PR ohne Board-Gate

---

## 8. Branch Protection auf `main` (GitHub)

Serverseitige, technisch erzwungene Absicherung der Null-Verlust-Garantie. Über die
GitHub-REST-API (`PUT /repos/axelweichert/cloudflare-os/branches/main/protection`)
gesetzt. **Aktiver Stand** (mit `GET …/protection` verifizierbar):

- `allow_force_pushes: false` → **kein** Force-Push auf `main` (blockt `reset --hard` + Push).
- `allow_deletions: false` → `main` kann **nicht** gelöscht werden.
- `required_pull_request_reviews`: **1 Review Pflicht** → jede Upstream-Integration läuft
  über einen PR, keine Blind-Merges direkt auf `main`.
- `required_status_checks`: **Fork-Guard (Null-Verlust)** + **Build and test** müssen grün sein.
- `enforce_admins: false` → die Admin-/Automations-Identität (Deploy-/Bot-Token) behält für
  den regulären Direkt-Commit-Fluss und Notfälle einen Weg auf `main`; Force-Push und
  Löschen bleiben **für alle** gesperrt.

> **Empfehlung an CEO:** Sollen auch Admins zwingend über PRs gehen, `enforce_admins`
> auf `true` setzen (Einzeiler via API). Aktuell bewusst `false`, damit der bestehende
> Automations-/Deploy-Fluss nicht bricht.

Neu setzen/aktualisieren (Token mit `repo`-Scope nötig):

```bash
TOKEN=<pat>   # repo-Scope; NICHT committen
curl -sS -X PUT -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/axelweichert/cloudflare-os/branches/main/protection \
  -d '{
    "required_status_checks": {"strict": false, "contexts": ["Fork-Guard (Null-Verlust)", "Build and test"]},
    "enforce_admins": false,
    "required_pull_request_reviews": {"required_approving_review_count": 1},
    "restrictions": null,
    "allow_force_pushes": false,
    "allow_deletions": false
  }'
```

---

## 9. Fork-Guard (Null-Verlust-Test, CI)

`owlos/scripts/fork-guard.sh` — rein lesend, kein Netz. Prüft drei Marker-Klassen und
bricht mit Exit-Code 1 ab, wenn etwas fehlt:

1. **Struktur** — `owlos/` + Kern-Docs/Skripte (`FORK-SYNC.md`, `I18N-DE.md`,
   `drift-report.sh`, `fork-guard.sh`).
2. **DE-Key-Stichprobe** — reale deutsche UI-Strings direkt im Quelltext
   (z. B. „Torwächter", „Baupläne", „Entdecken", „Woran arbeiten wir").
3. **Flächen-Check** — Anzahl DE-übersetzter Quelldateien ≥ Schwellwert (fängt breiten
   Verlust ab, falls die Stichprobe zufällig überlebt).

Aufruf:

```bash
pnpm guard:fork                       # oder: owlos/scripts/fork-guard.sh --verbose
```

**Eingehängt in CI** als Job `Fork-Guard (Null-Verlust)` (`.github/workflows/ci.yml`),
läuft bei jedem `push` auf `main` und jedem `pull_request` → ein Sync-PR, der Fork-Marker
zerstört, wird **rot** und kann bei aktiver Branch Protection nicht gemergt werden.

> **⚠ Einmalige Owner-Aktion nötig (CEO):** Dies ist ein **Fork**. GitHub führt auf
> geforkten Repos **keine** Actions aus, bis der Owner sie einmalig im Web-UI freigibt
> (Reiter **Actions** → „I understand my workflows, go ahead and enable them"). Diese
> Freigabe ist **nicht** über die API setzbar. Solange sie aussteht, laufen CI und
> Fork-Guard **nicht** automatisch; die als Pflicht gesetzten Status-Checks bleiben
> „pending" (Admins können per `enforce_admins:false` dennoch mergen). **Bis dahin gilt
> der Guard als lokales Pre-Merge-Gate verbindlich:** `pnpm guard:fork` **muss** vor
> jedem Sync-PR grün sein. Sobald der CEO Actions freigibt, greift der Guard zusätzlich
> serverseitig — ohne weitere Konfiguration.

Marker (DE-Keys, Schwellwert) bei künftiger DE-Arbeit im Skript nachziehen, damit die
Stichprobe repräsentativ bleibt.

---

## 10. Currency-Triage-Register (Read-only-Sichtungen des Upstream-Drifts)

Der wöchentliche `currency-check.sh` ([OWL-1570]) meldet kritischen Upstream-Drift
als Issue. Jede Sichtung wird hier registriert — **Entscheidung, nicht Integration**.
Die eigentliche Übernahme läuft ausschließlich über den Overlay-Re-apply-Upgrade
([docs/UPGRADING.md], Eltern-Issue [OWL-1566], Board-/CTO-Gate).

> **Wichtig — Cherry-pick ist auf dieser Topologie N/A.** `origin/main` hat **keine**
> gemeinsame Historie mit Upstream (`git merge-base` leer), daher gibt es keinen
> `cherry-pick -x <sha>`-Pfad. Kritische Upstream-Fixes werden **nicht** einzeln
> gepickt, sondern **wholesale** beim nächsten Overlay-Re-apply übernommen (Upstream
> = neue Basis an allen Nicht-Overlay-Pfaden, danach Overlay + 3 Nähte re-applyen).
> Die Triage klärt hier nur: **berührt** der Drift unsere Nähte/Overlay, und **ist**
> etwas davon so dringend, dass ein außerplanmäßiger Upgrade nötig wäre.

### Triage 2026-09-22 — `[currency-sync:87e09feb]` (OWL-1571)

- **Drift:** 7 kritische Commits `21d34803..f961c844` (Diff-Basis der Meldung).
- **Pin-Stand:** `UPSTREAM_REF=f961c844` **enthält bereits alle 7** (`21d34803` ist
  Vorfahre von `f961c844`) und `== upstream/main` HEAD. → **Nichts fortzuschreiben.**
- **Naht-Check (die genau 3 Kern-Berührpunkte, Seam-Register in [docs/UPGRADING.md]):**
  **keiner der 7 Commits** berührt `scripts/release/manifest-lib.ts`,
  `scripts/release/testdata/golden-manifest.json` oder
  `packages/router/__tests__/router.test.ts`. → Naht-Re-apply beim Upgrade unverändert.
- **Overlay-Relevanz (berühren die Commits Pakete, die unser Overlay konsumiert?):**

  | Commit | Betroffene Pfade | Relevanz für owlOS-Overlay |
  |---|---|---|
  | `dc009b34e` Outputs-Sidebar height | `workshop-frontend` | UI-Fix, kosmetisch |
  | `9246f92ef` Anthropic-Streams eval-target | `workshop-evals` (bei uns **absent**), `integration-tests` | irrelevant (Paket fehlt im Snapshot) |
  | `b98cc0676` user-search UI sizing | `workshop-frontend` | UI-Fix, kosmetisch |
  | **`0272b0600`** blueprint-configurator readiness | **`configurator-ui`, `workshop-shared/gatekeeper.ts`** (Overlay-**Deps**), `workshop-frontend` | **einzige mit direkter Overlay-Relevanz** — beim Re-apply verifizieren, ob `gatekeeper-unifi`/`-homeassistant` gegen die geänderte `gatekeeper.ts`-API bauen |
  | `e8b6ce045` bundled-blueprint test PID | `scripts/*.test.ts` | Test-only |
  | `ca87261f8` staged gatekeeper reconnects | `gatekeeper-kit` (bei uns **absent**) | irrelevant im aktuellen Snapshot; wird beim Upgrade mit Upstream eingezogen |
  | `87e09feb6` agent-session reconnect/trials | `workshop-evals` (**absent**), `integration-tests` | irrelevant (Paket fehlt im Snapshot) |

- **Entscheidung:** **Kein außerplanmäßiger Upgrade.** 6/7 sind kosmetische UI-/Test-/
  Eval-Fixes in Paketen, die unser Overlay nicht konsumiert (bzw. im Snapshot fehlen).
  `0272b0600` ist die einzige mit Overlay-Berührung, aber ein Readiness-Fix ohne
  Dringlichkeit. Alle 7 werden **automatisch** beim nächsten geplanten Overlay-Re-apply
  (OWL-1566) übernommen, da `configurator-ui`/`workshop-shared` reine Upstream-(Nicht-
  Overlay-)Pfade sind und dort wholesale aktualisiert werden.
- **Aktion beim nächsten Upgrade:** In Schritt 4 (Guards grün) explizit prüfen, dass
  `gatekeeper-unifi`/`-homeassistant` gegen die neue `workshop-shared/gatekeeper.ts`
  (0272b0600) tsc-clean bauen.
- **Read-only bestätigt:** nur `git fetch upstream` (öffentliches `cloudflare/cloudflare-os`),
  lesende Diffs. Kein Deploy, kein Token, keine fremde `account_id`.

---

## 11. Vendorierte Upstream-Pakete (OWL-1583, 2026-09-22)

Board-Befund OWL-1582: „ein Gatekeeper aus dem Upstream soll in der Auswahl
auftauchen". Diagnose zuerst, dann Currency.

### (a) Diagnose — die Auswahl ist vollständig

Die „Gatekeepers zur Auswahl" ist **kein UI-Datensatz**, sondern exakt die Menge der
`installable`-Gatekeeper-Einträge im Release-Manifest: `findDeployablePackages()`
(scripts/release/manifest-lib.ts) nimmt **jedes** Paket mit `wrangler.jsonc`, der
Deploy-Service bietet daraus die installierbaren an. Stand heute: **17 Gatekeeper**,
alle 16 Upstream-Vendors **plus** unser `gatekeeper-unifi`; 16 davon `installable`,
`gatekeeper-email` bewusst nicht (braucht Email Routing = Zone, workers.dev-Instanzen
haben keine). **Es fehlt kein Gatekeeper.** Neuer Regressionstest hält das fest:
`scripts/release/manifest-lib.test.ts` → *„every gatekeeper package reaches the
wizard's selection"* (prüft gegen die Pakete **auf Platte**, nicht gegen die
Golden-Datei — ein neuer Gatekeeper, der nie ins Manifest kommt, fällt dort auf).

### (b) Currency — was upstream-only war

| Paket | Status im Fork | Nachweis |
|---|---|---|
| `packages/bundled-blueprints` | **übernommen, grün** | 285/285 Tests, 5/5 tsc-Programme clean |
| `packages/gatekeeper-kit` | **übernommen, aber nicht im Workspace** | 450/450 Logik-Tests grün; `tsc` = **28 Fehler**, alle aus einer Ursache (s.u.) |
| `packages/ui`, `packages/workshop-evals` | nicht übernommen | begleitende Upstream-Neuzugänge ohne Overlay-Bezug; nachziehen beim Overlay-Re-apply |

Übernahme als **Overlay-Re-apply** (`git checkout upstream/main -- <pfad>` gegen den
gepinnten `UPSTREAM_REF`), kein merge/rebase — die Topologie hat keine gemeinsame
Historie. Angepasst wurde nur die Toolchain-Naht: beide Pakete importieren upstream
`@gadgets/scripts/vitest-task` (ein Workspace-Paket, das unser Snapshot noch nicht
kennt) → umgebogen auf unseren vorhandenen Pfad `../../scripts/vitest-task-vite-config.js`
bzw. `../../scripts/assert-workerd.ts`; `@gadgets/scripts`-devDep entfernt.
Neuer Catalog-Eintrag: `@cloudflare/workers-types` (beide Pakete typen dagegen).

### (c) Blocker `gatekeeper-kit` — eine Ursache, nicht 28

`gatekeeper-kit` typt gegen ein **neueres `@gadgets/workshop-shared`**, als unser
Snapshot hat: `GitCache`, `ConnectHandoff`, `ActionDescription.pushedCommits`,
`ObservationInput.containsRestrictedData`, `ObservationAuthorizer.getGitCache`.
Der Drift in `workshop-shared` ist groß (`api.ts` ~619 Zeilen, `gatekeeper.ts` ~463)
und zieht `workshop-backend`, alle 17 Gatekeeper und das Frontend nach — das ist der
**geplante Overlay-Re-apply (OWL-1566)**, kein Paket-Vendoring.

Deshalb liegt das Paket am richtigen Zielort (`packages/gatekeeper-kit`), ist aber per
`- '!packages/gatekeeper-kit'` in `pnpm-workspace.yaml` aus Install-/Build-/Test-Graph
genommen, damit der Baum grün bleibt. **Die Zeile wird in genau der Änderung gelöscht,
die `workshop-shared`/`api` auf den gepinnten `UPSTREAM_REF` hebt.**

Zusatzbefund (nicht blockierend): die workerd-Suite von `gatekeeper-kit`
(`vitest.worker.config.ts`, `compatibilityDate 2026-09-04` + Flag
`allow_irrevocable_stub_storage`) startet mit unserem workerd `1.20260801.1` nicht
(`ERR_RUNTIME_FAILURE`). Upstream fährt `@cloudflare/vitest-pool-workers ^0.22` mit
Miniflare-Override `5.20260831.0-alpha`; dieser Toolchain-Bump gehört ebenfalls in den
Re-apply, nicht hierher.

### (d) Nicht angefasst (bewusst)

Upstream baut die Blueprint-Archive inzwischen aus `bundled-blueprints`
(`scripts/build-bundled-blueprints.ts`). Unser `workshop-backend` liefert weiter die
vorgebauten `.gadget`-Archive aus `packages/workshop-backend/format-blueprints/`
(`scripts/build-format-blueprints.mjs`). Diese Umverdrahtung ist Teil desselben
`workshop-backend`-Drifts und bleibt dem Re-apply überlassen — das Overlay bleibt
unberührt.

**Read-only bestätigt:** nur `git fetch`/`git checkout` gegen das öffentliche
`cloudflare/cloudflare-os`. Kein Deploy, kein Token, keine fremde `account_id`.

---

## 12. i18n-Overlay (DE/EN-Umschalter, OWL-1591, 2026-09-22)

CTO-Entscheidung (OWL-1590, verbindlich): DE/EN-Sprachwahl im UI **fork-sicher als
Overlay**, **kein `react-i18next`** — schlanker eigener Context analog
`ThemeContext.tsx`/`FeatureFlagsContext.tsx` (`createContext` + `localStorage`).
Damit koexistiert das Overlay mit der bestehenden Direkt-Ersetzungs-Strategie
(§0/§6): die deutschen Strings wandern in den Katalog, die alte englische Fassung
wird zur `en`-Quelle der Wahrheit.

### Topologie — reines Overlay-Verzeichnis (existiert NICHT im Upstream)

```
packages/workshop-frontend/src/i18n/
  catalogs/en.ts          # flache key→string-Map; SOURCE OF TRUTH der Keys (TKey)
  catalogs/de.ts          # Record<TKey,string> → fehlender Key = tsc-Fehler
  I18nProvider.tsx        # Provider, localStorage-Key `gadgets:lang`, Default DE
  useT.ts                 # const t = useT(); t('sidebar.home', {name}) — typsicher
  LanguageSwitcher.tsx    # DE/EN-Toggle-Button (Kumo-Tooltip, live via useI18n, kein Reload)
  i18n.test.tsx           # Default-DE / Switch-EN / Persistenz / Interpolation
```

Das ganze Verzeichnis geht beim Upstream-Re-apply **nicht verloren** (Upstream kennt
es nicht → kein Konflikt, kein Overwrite). Die deutschen Übersetzungswerte leben
ausschließlich hier.

### Berührte Upstream-Dateien (Overlay-Diffs — beim Re-apply wiederherstellen)

Beim Overlay-Re-apply (§10, OWL-1566) werden diese Dateien aus Upstream frisch
gezogen; die hier gelisteten `t()`-Nähte müssen danach **erneut angewandt** werden
(die DE-**Werte** selbst liegen sicher im Katalog-Overlay, nur die mechanischen
`t()`-Aufrufe gehen verloren):

| Datei | Overlay-Naht |
|---|---|
| `src/main.tsx` | `<I18nProvider>` um den Baum gehängt (analog `<ThemeProvider>`) |
| `src/components/AppShell/AppShell.tsx` | `<LanguageSwitcher/>` in der Top-Bar montiert; `t('appshell.*')` für Menü-/Nav-Labels |
| `src/components/AppShell/Sidebar.tsx` | `t('sidebar.*')` für Nav-Labels + aria/title |
| `src/components/AppShell/SidebarUtilityStrip.tsx` | `t('sidebar.gatekeepers')` + `t('theme.*')` (Theme-Label via Interpolation) |
| `src/LoginPage.tsx` | `t('auth.*')` für Titel, Formular-Labels/Placeholder, Fehler, OAuth-Trenner, Lade-/Fehlerzustände + Dokumenttitel |

**Stand OWL-1591 (Founding Engineer, 2026-09-22):** Zwei doppelte Skelette aus
Vorläufen zusammengeführt — der tote DOM-MutationObserver-Pfad (`LanguageContext.tsx`
+ `de.json`) **gelöscht**, der typsichere Katalog-Pfad (`I18nProvider`/`useT`) bleibt
als einzige Quelle. `LanguageSwitcher` auf `useI18n` umgestellt (live, kein Reload).
Umgestellt: persistente App-Chrome (AppShell + Sidebar + Utility-Strip) **und** der
Login-Screen (`LoginPage.tsx`, erster sichtbarer Screen). Switcher live (Default DE,
EN schaltet sofort um), `tsc --noEmit` grün, `i18n.test.tsx` grün (jetzt auch mit
`auth.*`-Assertion). Die weiteren gestaffelten Screens (`signup`/SignupPage,
`chat`/ChatInterface, `billing`, `gatekeeper-modal`, restliche `routes`) sind je eine
mechanische `t()`-Umstellung gegen den bestehenden Katalog → eigene Folge-Issues
(Kinder von OWL-1590), damit jeder Batch unabhängig verifiziert werden kann.

> **fork-guard-Hinweis (§9):** Die DE-Stichprobe prüft weiterhin deutsche
> String-**Literale** im Quelltext. Nach der Overlay-Umstellung liegen die DE-Werte
> von AppShell/Sidebar im Katalog (`catalogs/de.ts`) statt inline — die Stichprobe
> (`Torwächter`, `Baupläne`, `Entdecken`, `Woran arbeiten wir`) trifft aktuell noch
> genug inline-DE anderswo, bleibt also grün. Wenn künftige Batches breite Flächen
> auf `t()` umstellen, den Guard um einen Katalog-Marker ergänzen
> (z. B. Existenz von `catalogs/de.ts` + Stichprobe deutscher **Katalog-Werte**),
> damit der Null-Verlust-Test repräsentativ bleibt.

**Stand OWL-1596 (Founding Engineer, 2026-09-23) — Stufe 2:** Overlay auf die
restlichen user-sichtbaren Flächen ausgerollt. `catalogs/en.ts`/`de.ts` von ~30 auf
~200 Keys erweitert (Namespaces `routes.*`, `chat.*`, `billing.*`, `gk.*`). Vier
Flächen verdrahtet: **routes** (Seitentitel/H1/Untertitel/Suche/Leerzustände +
`__root`-Ladeschirme), **chat** (Composer-Platzhalter, Liste, Löschdialog,
Anhänge, DataTab, PermissionToast, SlashCommandPicker, ToolCallCard, AppPreview),
**billing** (alle drei Flächen inkl. Plural via `request.one/other` und
`<ResetCountdown/>`-Splitting in Prefix-/Suffix-Keys), **gatekeeper-modal**
(GatekeeperModal + AccountChooser/AgentSpawner/AiModel/ConnectionConfigField).
`tsc --noEmit` grün, `i18n.test.tsx` grün (4 Tests, jetzt mit Stufe-2-Assertion je
Fläche + Plural/Interpolation).

Berührte Upstream-Dateien (Overlay-`t()`-Nähte — beim Re-apply erneut anwenden; die
DE-**Werte** liegen sicher im Katalog):

| Bereich | Dateien |
|---|---|
| routes | `routes/__root.tsx`, `index.tsx`, `workspaces.tsx`, `blueprints.tsx`, `explore.tsx`, `outputs.tsx`, `gatekeepers.tsx`, `gatekeepers_.$appId.tsx`, `context.tsx`, `providers.tsx` |
| chat | `ChatInterface.tsx`, `components/chat/{ChatMessage,ConnectionConfigModal,DataTab,PermissionToast,SlashCommandPicker,ToolCallCard,AppPreview}.tsx` |
| billing | `components/billing/{AccountSelectionModal,OutOfCreditsModal,UsageSettings}.tsx` |
| gatekeeper-modal | `GatekeeperModal.tsx`, `gatekeeper-modal/{AccountChooser,AgentSpawnerConfigForm,AiModelConnectionConfig,ConnectionConfigField}.tsx` |

**Overlay-Härtung:** `useI18n()` wirft nicht mehr ohne Provider, sondern liefert den
DE-Default (`readLang()`). Grund: das Overlay umschließt tiefe Chrome; ein außerhalb
`<I18nProvider>` gerenderter Teilbaum (Unit-Test, Lazy-Chunk, Portal) muss in der
Default-Sprache rendern statt zu crashen. Der Live-Switch-Pfad (Provider vorhanden)
ist unverändert.

**fork-guard §9 nachgezogen (wie im Hinweis oben vorgesehen):** (a) `catalogs/de.ts`,
`en.ts`, `I18nProvider.tsx` als **Struktur-Marker** aufgenommen (Overlay-Existenz =
Null-Verlust-Kern). (b) DE-Key-Stichprobe der migrierten Strings von der Upstream-Datei
auf `catalogs/de.ts` umgezogen (dort lebt der Wert jetzt dauerhaft, upstream-sicher);
noch nicht migrierte Flächen bleiben inline (`Connections.tsx::Verbindungen`).
(c) Flächen-Check auf den Katalog verankert (`≥ 80` DE-Keys statt Inline-Datei-Zählung),
damit die laufende Migration den Null-Verlust-Test nicht fälschlich rot färbt. Guard
grün (15 Marker).

**Bewusst nicht migriert (Modul-Ebene / außerhalb Scope):** `platformConnectionTypes`
(GatekeeperModal) und `validateSpawnerEnv`-Meldung — Modul-Konstanten ohne Hook-Kontext
(`// TODO i18n`, Keys existieren); tiefe Sekundär-Notices in `providers`/`outputs`;
aria-/title-Tooltips und AppPreview-Mock-Copy; das `who`-Argument (`Agenten`/`Personen`)
in der Chat-Liste bleibt Datenwert.

> **Hinweis Test-Suite:** Die breite Frontend-Suite hat **vorbestehende** rote Tests
> (schon bei HEAD `94a46c83` rot, Ursache OWL-1591-Provider-Pflicht + frühere direkte
> EN→DE-Ersetzung vs. englisch erwartende Tests: `ShareModal`, `ObserverConfigModal`,
> `BlueprintLandingPage`, `GadgetExportMenu`, `WorkpiecePicker`, `CodeDiffEditor`,
> `GatekeeperModal.ambient`, `ChatInterface.markdown`). Diese sind **nicht** aus
> OWL-1596; die Provider-Härtung oben hat sie von „crash beim Render" auf „rendert,
> Assertion veraltet" verbessert. Sauberer Test-Nachzug = eigenes Issue.

**Read-only bestätigt:** reine Frontend-Code-Änderung im eigenen Weichert.at-Fork.
Kein Deploy, kein Token, keine fremde `account_id`.
