#!/usr/bin/env bash
#
# fork-guard.sh — Null-Verlust-Wächter für den von-Busch-Fork von Cloudflare OS.
#
# Zweck (Board-Vorgabe VON-1902 / VON-1905): "Es darf nichts von unseren
# Änderungen verloren gehen." Dieses Skript verifiziert nach JEDER Integration
# (Cherry-pick, Merge, Rebase-Unfall …), dass unsere Fork-Marker weiterhin
# vorhanden sind. Fehlt auch nur ein Marker, bricht das Skript mit Exit-Code 1
# ab → CI/Pre-Merge schlägt fehl, die Integration darf nicht landen.
#
# Es prüft drei Klassen von Markern:
#   (1) STRUKTUR   — unser vonbusch/-Verzeichnis + Kern-Dokumente/Skripte.
#   (2) DE-KATALOG — die deutschsprachigen Lokalisierungs-/Prozess-Dokumente.
#   (3) DE-KEYS    — Stichprobe REALER deutscher UI-Strings direkt im Quelltext
#                    (unsere direkte EN→DE-Ersetzung, siehe vonbusch/I18N-DE.md).
#
# Verwendung:
#   vonbusch/scripts/fork-guard.sh            # normaler Lauf (CI / lokal)
#   vonbusch/scripts/fork-guard.sh --verbose  # zeigt jeden geprüften Marker
#
# Rein lesend. Kein git-Zustand wird verändert. Kein Netzwerkzugriff.
# Prozess & Register: siehe vonbusch/FORK-SYNC.md
#
set -euo pipefail

VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

cd "$(git rev-parse --show-toplevel)"

RED=''; GREEN=''; YELLOW=''; BOLD=''; RESET=''
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
fi

FAILURES=0
CHECKS=0

pass() { CHECKS=$((CHECKS+1)); [ "$VERBOSE" = 1 ] && printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; return 0; }
fail() { CHECKS=$((CHECKS+1)); FAILURES=$((FAILURES+1)); printf '  %s✗ FEHLT%s %s\n' "$RED" "$RESET" "$1"; }

# ── (1) STRUKTUR: unser Fork-Verzeichnis + Kern-Artefakte ────────────────────
STRUCT_MARKERS=(
  "vonbusch"                              # das Fork-Wurzelverzeichnis überhaupt
  "vonbusch/FORK-SYNC.md"                 # Sync-Runbook (dieser Prozess)
  "vonbusch/I18N-DE.md"                   # DE-Glossar / Übersetzungsstrategie
  "vonbusch/scripts/drift-report.sh"      # Drift-Report (read-only)
  "vonbusch/scripts/fork-guard.sh"        # dieser Wächter selbst
  # i18n-Overlay (OWL-1590/1591/1596) — upstream-unbekanntes Verzeichnis, in dem
  # ab OWL-1596 die deutschen UI-Werte konsolidiert leben. Fehlt es, ist die
  # migrierte DE-Arbeit verloren → Null-Verlust-Verletzung.
  "packages/workshop-frontend/src/i18n/catalogs/de.ts"
  "packages/workshop-frontend/src/i18n/catalogs/en.ts"
  "packages/workshop-frontend/src/i18n/I18nProvider.tsx"
)

echo "── (1) Struktur-Marker (vonbusch/) ──"
for m in "${STRUCT_MARKERS[@]}"; do
  if [ -e "$m" ]; then pass "$m"; else fail "$m (Verzeichnis/Datei fehlt)"; fi
done
echo ""

# ── (3) DE-KEYS: Stichprobe realer deutscher UI-Strings im Quelltext ─────────
# Format: "<Datei>::<gesuchter deutscher String>"
# Diese Strings sind unsere Fork-DE-Arbeit. Verschwinden sie (z. B. durch einen
# blinden Upstream-Merge/-Reset), ist Fork-Arbeit verloren → Abbruch.
#
# i18n-Migration (OWL-1590/1591/1596): sobald eine Fläche auf den i18n-Overlay
# (`t()`) umgestellt ist, lebt der deutsche WERT nicht mehr inline in der Upstream-
# Datei, sondern im Overlay-Katalog `i18n/catalogs/de.ts` (liegt im vonbusch-
# unbekannten Overlay-Verzeichnis → upstream-sicher, kein Re-apply nötig). Der
# Marker wandert dann mit: er zeigt auf den Katalog, wo der Wert dauerhaft lebt.
# Noch NICHT migrierte Flächen bleiben als Inline-Marker (Connections, GK-Hero).
DE_KEY_MARKERS=(
  "packages/workshop-frontend/src/i18n/catalogs/de.ts::Woran arbeiten wir"
  "packages/workshop-frontend/src/i18n/catalogs/de.ts::Torwächter"
  "packages/workshop-frontend/src/i18n/catalogs/de.ts::Baupläne"
  "packages/workshop-frontend/src/i18n/catalogs/de.ts::Entdecken"
  "packages/workshop-frontend/src/i18n/catalogs/de.ts::Anmelden"
  "packages/workshop-frontend/src/Connections.tsx::Verbindungen"
)

echo "── (3) DE-Key-Stichprobe (reale Übersetzungen im Quelltext) ──"
for entry in "${DE_KEY_MARKERS[@]}"; do
  file="${entry%%::*}"
  needle="${entry##*::}"
  if [ ! -f "$file" ]; then
    fail "$needle  ($file — Datei fehlt)"
  elif grep -qF -- "$needle" "$file"; then
    pass "\"$needle\"  in $file"
  else
    fail "\"$needle\"  in $file (deutscher String verschwunden)"
  fi
done
echo ""

# ── Gesamt-Zählwerk: sind überhaupt noch nennenswert viele DE-Strings da? ─────
# Fängt den Fall ab, dass die Stichprobe zufällig überlebt, aber eine breite
# Rückabwicklung (z. B. reset --hard upstream) fast alle DE-Werte entfernt hätte.
#
# Zwei komplementäre Quellen (OR — eine reicht, beide werden angezeigt):
#   (a) Katalog-Werte  — ab OWL-1596 der kanonische DE-Sitz. Jeder migrierte
#       String ist eine Zeile in catalogs/de.ts. Wächst mit der Migration; ein
#       Upstream-Reset (Katalog existiert dort nicht) fiele auf 0 → rot.
#   (b) Inline-DE-Dateien — noch nicht migrierte Flächen mit deutschen Literalen.
#       Schrumpft naturgemäß mit der i18n-Migration; nur informativ, nicht mehr
#       allein maßgeblich (sonst würde legitime Migration den Guard fälschlich rot).
MIN_DE_CATALOG=80   # de.ts hält aktuell ~200 Keys. Upstream hätte 0. Großer Puffer.
DE_CATALOG_COUNT=$(grep -cE "^\s*'[A-Za-z0-9.]+'\s*:" \
  packages/workshop-frontend/src/i18n/catalogs/de.ts 2>/dev/null || echo 0)
DE_FILE_COUNT=$(grep -rIlE 'Torwächter|Baupläne|Entdecken|Verbindungen|Einstellungen|Woran arbeiten wir' \
  packages/workshop-frontend/src packages/workshop-backend/src 2>/dev/null | wc -l | tr -d ' ')
echo "── Flächen-Check: DE-Werte (Katalog + Inline) ──"
CHECKS=$((CHECKS+1))
if [ "$DE_CATALOG_COUNT" -ge "$MIN_DE_CATALOG" ]; then
  printf '  %s✓%s %s DE-Katalog-Keys (Mindestwert: %s) + %s Inline-DE-Dateien (informativ)\n' \
    "$GREEN" "$RESET" "$DE_CATALOG_COUNT" "$MIN_DE_CATALOG" "$DE_FILE_COUNT"
else
  FAILURES=$((FAILURES+1))
  printf '  %s✗ FEHLT%s nur %s DE-Katalog-Keys (erwartet ≥ %s) → breiter DE-Verlust?\n' \
    "$RED" "$RESET" "$DE_CATALOG_COUNT" "$MIN_DE_CATALOG"
fi
echo ""

# ── Ergebnis ─────────────────────────────────────────────────────────────────
echo "==================================================================="
if [ "$FAILURES" -eq 0 ]; then
  printf '%s%s✓ FORK-GUARD GRÜN%s — alle %s Marker vorhanden. Keine Fork-Arbeit verloren.\n' \
    "$BOLD" "$GREEN" "$RESET" "$CHECKS"
  echo "==================================================================="
  exit 0
else
  printf '%s%s✗ FORK-GUARD ROT%s — %s von %s Marker(n) FEHLEN.\n' \
    "$BOLD" "$RED" "$RESET" "$FAILURES" "$CHECKS"
  printf '%sIntegration NICHT übernehmen.%s Wiederherstellen aus dem Pre-Sync-Sicherungspunkt:\n' "$YELLOW" "$RESET"
  echo "    git tag --list 'vonbusch/pre-sync-*'"
  echo "    git reset --hard vonbusch/pre-sync-<DATUM>   # nur auf dem Sync-Branch!"
  echo "  Details: vonbusch/FORK-SYNC.md, Abschnitt 'Null-Verlust-Garantie'."
  echo "==================================================================="
  exit 1
fi
