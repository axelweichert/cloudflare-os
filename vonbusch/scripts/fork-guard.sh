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
)

echo "── (1) Struktur-Marker (vonbusch/) ──"
for m in "${STRUCT_MARKERS[@]}"; do
  if [ -e "$m" ]; then pass "$m"; else fail "$m (Verzeichnis/Datei fehlt)"; fi
done
echo ""

# ── (3) DE-KEYS: Stichprobe realer deutscher UI-Strings im Quelltext ─────────
# Format: "<Datei>::<gesuchter deutscher String>"
# Diese Strings sind unsere direkte EN→DE-Ersetzung. Verschwinden sie (z. B.
# durch einen blinden Upstream-Merge/-Reset), ist Fork-Arbeit verloren → Abbruch.
# Bewusst breit über Kernflächen gestreut (Home, Sidebar, Torwächter, Baupläne,
# Entdecken, Verbindungen), damit ein flächiger Verlust sicher auffällt.
DE_KEY_MARKERS=(
  "packages/workshop-frontend/src/routes/index.tsx::Woran arbeiten wir"
  "packages/workshop-frontend/src/routes/gatekeepers.tsx::Torwächter"
  "packages/workshop-frontend/src/routes/blueprints.tsx::Baupläne"
  "packages/workshop-frontend/src/routes/explore.tsx::Entdecken"
  "packages/workshop-frontend/src/Connections.tsx::Verbindungen"
  "packages/workshop-frontend/src/components/AppShell/Sidebar.tsx::Baupläne"
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
# Rückabwicklung (z. B. reset --hard upstream) fast alle DE-Strings entfernt hätte.
MIN_DE_FILES=20   # Baseline 2026-08-27: 26 Dateien. Upstream hätte 0. Puffer für legitime Churn.
DE_FILE_COUNT=$(grep -rIlE 'Torwächter|Baupläne|Entdecken|Verbindungen|Einstellungen|Woran arbeiten wir' \
  packages/workshop-frontend/src packages/workshop-backend/src 2>/dev/null | wc -l | tr -d ' ')
echo "── Flächen-Check: DE-übersetzte Quelldateien ──"
CHECKS=$((CHECKS+1))
if [ "$DE_FILE_COUNT" -ge "$MIN_DE_FILES" ]; then
  printf '  %s✓%s %s DE-Quelldateien gefunden (Mindestwert: %s)\n' "$GREEN" "$RESET" "$DE_FILE_COUNT" "$MIN_DE_FILES"
else
  FAILURES=$((FAILURES+1))
  printf '  %s✗ FEHLT%s nur %s DE-Quelldateien gefunden (erwartet ≥ %s) → breiter Verlust?\n' \
    "$RED" "$RESET" "$DE_FILE_COUNT" "$MIN_DE_FILES"
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
