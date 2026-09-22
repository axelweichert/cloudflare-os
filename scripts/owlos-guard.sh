#!/usr/bin/env bash
#
# owlos-guard.sh — Naht-Wächter für die owlOS-Gatekeeper im CloudflareOS-Fork.
#
# Schwesterskript zu vonbusch/scripts/fork-guard.sh, aber mit anderem Fokus:
# fork-guard schützt die DE-Lokalisierung, DIESES Skript schützt die owlOS-
# Gatekeeper-Erweiterungen (gatekeeper-unifi, gatekeeper-homeassistant) an den
# GENAU DREI Berührpunkten, an denen sie Upstream-Kern-Dateien anfassen
# ("Seam-Register", siehe docs/UPGRADING.md).
#
# Warum: `origin/main` ist ein Snapshot-Fork OHNE gemeinsame Historie mit
# `cloudflare/cloudflare-os` (`git merge-base` leer, OWL-1566). Ein Upstream-
# Upgrade läuft daher als Overlay-Re-apply, NICHT als Merge/Cherry-pick. Dabei
# ist das Risiko, dass genau diese drei winzigen Naht-Änderungen still verloren
# gehen (die Paketverzeichnisse selbst sind rein additiv und fallen sofort auf).
# Fehlt ein Naht-Marker → Exit 1 → CI rot → Overlay unvollständig, nicht landen.
#
# Verwendung:
#   scripts/owlos-guard.sh            # normaler Lauf (CI / lokal)
#   scripts/owlos-guard.sh --verbose  # zeigt jeden geprüften Marker
#
# Rein lesend. Kein git-Zustand wird verändert. Kein Netzwerkzugriff.
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

MANIFEST_LIB="scripts/release/manifest-lib.ts"
GOLDEN="scripts/release/testdata/golden-manifest.json"
ROUTER_TEST="packages/router/__tests__/router.test.ts"

# Die owlOS-Gatekeeper: Paket-Name (Verzeichnis) + shortName (Router-Segment).
OWLOS_GATEKEEPERS=(
  "gatekeeper-unifi:unifi"
  "gatekeeper-homeassistant:homeassistant"
)

# ── (1) PAKET: Verzeichnis + wrangler.jsonc ──────────────────────────────────
# findDeployablePackages() (scripts/release/manifest-lib.ts) entdeckt einen
# Worker allein daran, dass packages/<name>/wrangler.jsonc existiert. Fehlt die
# Datei, taucht der Gatekeeper NICHT im generierten Manifest auf → unsichtbar.
echo "── (1) Paket-Marker (packages/<gk>/wrangler.jsonc) ──"
for entry in "${OWLOS_GATEKEEPERS[@]}"; do
  pkg="${entry%%:*}"
  wr="packages/$pkg/wrangler.jsonc"
  if [ -f "$wr" ]; then pass "$wr"; else fail "$wr (Paket/Config fehlt → nicht deploybar)"; fi
done
echo ""

# ── (2) NAHT A: NO_DEFAULT_CRED_INPUTS in manifest-lib.ts ────────────────────
# Beide Gatekeeper bringen ihre Credentials in-app mit (kein zentraler OAuth-
# App-Secret). Fehlt der shortName im Set, injiziert der Release-Build Default-
# Cred-Inputs, die es nicht gibt → kaputte Install-UX.
echo "── (2) Naht A: NO_DEFAULT_CRED_INPUTS ($MANIFEST_LIB) ──"
if [ ! -f "$MANIFEST_LIB" ]; then
  fail "$MANIFEST_LIB (Datei fehlt)"
else
  cred_block="$(awk '/NO_DEFAULT_CRED_INPUTS = new Set\(\[/{f=1} f{print} /\]\);/{if(f)exit}' "$MANIFEST_LIB")"
  for entry in "${OWLOS_GATEKEEPERS[@]}"; do
    pkg="${entry%%:*}"
    if printf '%s' "$cred_block" | grep -qF "\"$pkg\""; then
      pass "$pkg im NO_DEFAULT_CRED_INPUTS-Set"
    else
      fail "$pkg NICHT im NO_DEFAULT_CRED_INPUTS-Set"
    fi
  done
fi
echo ""

# ── (3) NAHT B: golden-manifest.json ─────────────────────────────────────────
# Der eingecheckte generierte Manifest-Snapshot MUSS beide Worker enthalten
# (Key + shortName + BASE_URL-Route). manifest-lib.test.ts erzwingt, dass das
# Golden dem echten Generat entspricht; hier prüfen wir, dass die owlOS-Worker
# im Golden überhaupt (noch) gelistet sind.
echo "── (3) Naht B: golden-manifest.json ──"
if [ ! -f "$GOLDEN" ]; then
  fail "$GOLDEN (Datei fehlt)"
else
  for entry in "${OWLOS_GATEKEEPERS[@]}"; do
    pkg="${entry%%:*}"; sn="${entry##*:}"
    grep -qF "\"$pkg\":"        "$GOLDEN" && pass "Worker-Key \"$pkg\""        || fail "Worker-Key \"$pkg\" im Golden"
    grep -qF "\"shortName\": \"$sn\"" "$GOLDEN" && pass "shortName \"$sn\""     || fail "shortName \"$sn\" im Golden"
    grep -qF "/gatekeeper/$sn"  "$GOLDEN" && pass "Route /gatekeeper/$sn"       || fail "Route /gatekeeper/$sn im Golden"
  done
fi
echo ""

# ── (4) NAHT C: router.test.ts Routen-Zusicherung ────────────────────────────
# Der Router entdeckt Gatekeeper dynamisch über GATEKEEPER_*-Env-Keys; es gibt
# keine hartkodierte Route. Die einzige Fork-Naht im Router ist der Test, der
# beweist, dass /gatekeeper/<sn>/* auf den richtigen Fetcher zeigt. Fällt er
# beim Overlay raus, verlieren wir die Regressionsabsicherung der Route.
echo "── (4) Naht C: Router-Routen-Test ($ROUTER_TEST) ──"
if [ ! -f "$ROUTER_TEST" ]; then
  fail "$ROUTER_TEST (Datei fehlt)"
else
  for entry in "${OWLOS_GATEKEEPERS[@]}"; do
    sn="${entry##*:}"
    if grep -qF "/gatekeeper/$sn/" "$ROUTER_TEST"; then
      pass "Routen-Assertion /gatekeeper/$sn/…"
    else
      fail "Routen-Assertion /gatekeeper/$sn/… im Router-Test"
    fi
  done
fi
echo ""

# ── Ergebnis ─────────────────────────────────────────────────────────────────
echo "==================================================================="
if [ "$FAILURES" -eq 0 ]; then
  printf '%s%s✓ OWLOS-GUARD GRÜN%s — alle %s Naht-Marker vorhanden. owlOS-Gatekeeper intakt.\n' \
    "$BOLD" "$GREEN" "$RESET" "$CHECKS"
  echo "==================================================================="
  exit 0
else
  printf '%s%s✗ OWLOS-GUARD ROT%s — %s von %s Marker(n) FEHLEN.\n' \
    "$BOLD" "$RED" "$RESET" "$FAILURES" "$CHECKS"
  printf '%sOverlay unvollständig — owlOS-Naht nach dem Upstream-Upgrade re-applyen.%s\n' "$YELLOW" "$RESET"
  echo "  Register der 3 Nähte: docs/UPGRADING.md, Abschnitt 'Seam-Register'."
  echo "==================================================================="
  exit 1
fi
