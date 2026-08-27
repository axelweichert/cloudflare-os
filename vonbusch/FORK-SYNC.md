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
   Vor **jeder** Integration ein unveränderlicher Tag `vonbusch/pre-sync-YYYYMMDD`.
   Damit ist der Vor-Sync-Stand jederzeit exakt wiederherstellbar.

2. **Branch Protection auf `main` (GitHub, siehe Abschnitt 8).**
   Kein Force-Push, kein Löschen, PR-Review-Pflicht. Verhindert die tödlichen
   Befehle oben serverseitig — auch bei menschlichem/Automations-Fehler.

3. **Fork-Guard in CI (`vonbusch/scripts/fork-guard.sh`, siehe Abschnitt 9).**
   Verifiziert nach jeder Integration, dass unsere Fork-Marker (Verzeichnis
   `vonbusch/`, DE-Kataloge, Stichprobe realer DE-UI-Strings) weiterhin existieren.
   Fehlt ein Marker → CI **rot** → Merge blockiert.

**Wenn der Guard rot ist:** Integration **nicht** übernehmen. Sync-Branch aus dem
Sicherungspunkt wiederherstellen:

```bash
git tag --list 'vonbusch/pre-sync-*'                 # Sicherungspunkt finden
git reset --hard vonbusch/pre-sync-<DATUM>           # NUR auf dem Sync-Branch!
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
vonbusch/scripts/drift-report.sh            # fetch + Report gegen upstream/main
vonbusch/scripts/drift-report.sh --no-fetch # ohne fetch (offline)
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
git tag "vonbusch/pre-sync-$(date +%Y%m%d)" main
git push origin "vonbusch/pre-sync-$(date +%Y%m%d)"   # Sicherungspunkt auch remote
```

Damit ist der Zustand **vor** dem Sync jederzeit exakt wiederherstellbar
(`git reset --hard vonbusch/pre-sync-YYYYMMDD` — nur auf dem Sync-Branch). Tags
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
| `d56a004` #298 | Bound every action-log read path | **a** | nein (typed-storage/backend-Tests) | 🔎 **empfohlen: zeitnah** | DoS-/OOM-Schutz (unbeschränkte Reads). Konfliktarm. |
| `38892c0` #341 | git-storage crash recovery, loose ends | **a** | **ja** (agent.ts, overseer.ts) | ⏳ Issue anlegen | Datenintegrität/Crash-Recovery, aber großer Refactor genau unserer DE-Kern-Dateien → sorgfältig, eigene Aufgabe. |
| `6223e26` #334 | Resume action stream across reconnects | **a** | **ja** (ChatInterface.tsx) | 🔎 empfohlen | Reliability-Fix (Reconnect). Konflikt nur auf DE-Strings in ChatInterface. |
| `0d7793c` #344 | Keep observer registrations when re-verify fails | a (Skript: c) | **ja** (overseer.ts, 20 Z.) | 🔎 empfohlen | Robustheit-Fix Observer-Registrierung. Klein. |
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

- [ ] **Pre-Sync-Sicherungspunkt setzen** (`vonbusch/pre-sync-YYYYMMDD`, Abschnitt 3.0) — Pflicht.
- [ ] `vonbusch/scripts/drift-report.sh` laufen lassen
- [ ] Sync **nur** auf eigenem `sync/*`-Branch — nie `merge`/`reset`/`rebase` auf `main` (Null-Verlust-Garantie).
- [ ] (a)-Fixes prüfen → cherry-pick, Board informieren, Register-Zeile ✅
- [ ] (b)-Features → Board-Issue anlegen (⏳), bei Übernahme Glossar pflegen
- [ ] (c)-Rest → im Register als ⛔ vermerken
- [ ] DE-Konflikte nach Regel (Upstream-Logik + DE-String) auflösen
- [ ] Neue englische Upstream-Strings nach Glossar ([I18N-DE.md](./I18N-DE.md)) übersetzen
- [ ] **`vonbusch/scripts/fork-guard.sh` grün** (auch lokal vor dem PR: `pnpm guard:fork`).
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

`vonbusch/scripts/fork-guard.sh` — rein lesend, kein Netz. Prüft drei Marker-Klassen und
bricht mit Exit-Code 1 ab, wenn etwas fehlt:

1. **Struktur** — `vonbusch/` + Kern-Docs/Skripte (`FORK-SYNC.md`, `I18N-DE.md`,
   `drift-report.sh`, `fork-guard.sh`).
2. **DE-Key-Stichprobe** — reale deutsche UI-Strings direkt im Quelltext
   (z. B. „Torwächter", „Baupläne", „Entdecken", „Woran arbeiten wir").
3. **Flächen-Check** — Anzahl DE-übersetzter Quelldateien ≥ Schwellwert (fängt breiten
   Verlust ab, falls die Stichprobe zufällig überlebt).

Aufruf:

```bash
pnpm guard:fork                       # oder: vonbusch/scripts/fork-guard.sh --verbose
```

**Eingehängt in CI** als Job `Fork-Guard (Null-Verlust)` (`.github/workflows/ci.yml`),
läuft bei jedem `push` auf `main` und jedem `pull_request` → ein Sync-PR, der Fork-Marker
zerstört, wird **rot** und kann bei aktiver Branch Protection nicht gemergt werden.

Marker (DE-Keys, Schwellwert) bei künftiger DE-Arbeit im Skript nachziehen, damit die
Stichprobe repräsentativ bleibt.
