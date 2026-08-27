#!/usr/bin/env bash
#
# drift-report.sh — Upstream-Drift-Report für den von-Busch-Fork von Cloudflare OS.
#
# Zweck: Zeigt, was sich im Upstream (cloudflare/cloudflare-os) seit unserem letzten
# Sync-Stand geändert hat, kategorisiert nach:
#   (a) SECURITY / kritische Bugfixes  → zeitnah selektiv übernehmen (Board nur informieren)
#   (b) FEATURES die wir evtl. wollen  → als Issue aufnehmen, gezielt cherry-picken
#   (c) REST / Tests / irrelevant       → bewusst nicht übernehmen (nur registrieren)
#
# Verwendung:
#   vonbusch/scripts/drift-report.sh              # gegen upstream/main
#   vonbusch/scripts/drift-report.sh --no-fetch   # ohne git fetch (offline / bereits gefetcht)
#   UPSTREAM_REF=upstream/main LOCAL_REF=main vonbusch/scripts/drift-report.sh
#
# Kein automatischer Merge. Das Skript ist rein lesend (außer `git fetch`).
# Prozess & Register: siehe vonbusch/FORK-SYNC.md
#
set -euo pipefail

LOCAL_REF="${LOCAL_REF:-main}"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"
DO_FETCH=1
[ "${1:-}" = "--no-fetch" ] && DO_FETCH=0

cd "$(git rev-parse --show-toplevel)"

# Upstream-Remote sicherstellen (idempotent).
if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "→ upstream-Remote fehlt, richte ihn ein …" >&2
  git remote add upstream https://github.com/cloudflare/cloudflare-os.git
fi

if [ "$DO_FETCH" = 1 ]; then
  echo "→ git fetch upstream …" >&2
  git fetch upstream --no-tags --quiet
fi

MB=$(git merge-base "$LOCAL_REF" "$UPSTREAM_REF")
AHEAD=$(git rev-list --count "$UPSTREAM_REF..$LOCAL_REF")
BEHIND=$(git rev-list --count "$LOCAL_REF..$UPSTREAM_REF")
SHORTSTAT=$(git diff --shortstat "$LOCAL_REF" "$UPSTREAM_REF" | sed 's/^ *//')
MB_INFO=$(git show -s --format='%h  %ci  %s' "$MB")

echo "==================================================================="
echo " UPSTREAM-DRIFT-REPORT  ($LOCAL_REF  ↔  $UPSTREAM_REF)"
echo "==================================================================="
echo " Gemeinsame Basis : $MB_INFO"
echo " Fork voraus      : $AHEAD Commits (unsere DE-/Produkt-Arbeit)"
echo " Fork zurück      : $BEHIND Commits (Upstream-Neuerungen ungesynct)"
echo " Gesamt-Diff      : $SHORTSTAT"
echo "==================================================================="
echo ""

if [ "$BEHIND" -eq 0 ]; then
  echo "✓ Kein Upstream-Drift. Fork ist auf Höhe von $UPSTREAM_REF."
  exit 0
fi

# Heuristische Kategorisierung nach Commit-Betreff.
# a) security/kritisch: fix|bound|crash|leak|secur|vuln|CVE|overflow|panic|deadlock|race|recover|reconnect
# b) feature:           add|feature|support|introduce|implement|bump (deps/models)
# c) rest:              alles andere (v. a. reine Tests / Doks / Refactors)
classify() {
  local subj_lc; subj_lc="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  if printf '%s' "$subj_lc" | grep -qE 'secur|vuln|cve|overflow|leak|crash|panic|deadlock|race\b|bound|recover|reconnect|\bfix\b|hotfix|revert'; then
    echo a
  elif printf '%s' "$subj_lc" | grep -qE '\badd\b|feature|support|introduce|implement|\bbump\b|upgrade'; then
    echo b
  else
    echo c
  fi
}

# Datei-Overlap-Warnung: berührt der Commit DE-übersetzte Kernflächen?
# Heuristik: Dateien mit direkter EN→DE-Ersetzung → hohe Konfliktwahrscheinlichkeit.
DE_HOTSPOTS='packages/workshop-frontend/src|packages/workshop-backend/src/(agent|overseer|web-fetch)\.ts|packages/workshop-shared/src/api\.ts|components/AppShell'

emit_bucket() {
  local want="$1" title="$2" any=0
  echo "── $title ──"
  while IFS='|' read -r sha subj; do
    [ -z "$sha" ] && continue
    [ "$(classify "$subj")" = "$want" ] || continue
    any=1
    local files hot=""
    files=$(git show --stat --format='' "$sha" | grep -cE '\|')
    if git show --name-only --format='' "$sha" | grep -qE "$DE_HOTSPOTS"; then
      hot="  ⚠ berührt DE-Fläche → Konflikt erwartbar"
    fi
    printf '  %s  %s  (%s Dateien)%s\n' "$sha" "$subj" "$files" "$hot"
  done < <(git log --no-merges --reverse --format='%h|%s' "$MB..$UPSTREAM_REF")
  [ "$any" = 0 ] && echo "  (keine)"
  echo ""
}

emit_bucket a "(a) SECURITY / KRITISCHE FIXES  → zeitnah selektiv übernehmen, Board informieren"
emit_bucket b "(b) FEATURES  → als Issue aufnehmen, gezielt cherry-picken"
emit_bucket c "(c) REST / Tests / Refactor  → i. d. R. nicht übernehmen, nur registrieren"

echo "-------------------------------------------------------------------"
echo "Nächste Schritte:"
echo "  • (a) prüfen & cherry-picken:  git cherry-pick -x <sha>"
echo "  • (b) Board-Issue anlegen, dann gezielt cherry-picken"
echo "  • Jede Entscheidung im Drift-Register eintragen: vonbusch/FORK-SYNC.md"
echo "  • ⚠-markierte Commits: Konflikt in DE-Flächen manuell auflösen (DE-String behalten)"
echo "-------------------------------------------------------------------"
