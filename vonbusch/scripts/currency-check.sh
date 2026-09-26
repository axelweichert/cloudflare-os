#!/usr/bin/env bash
#
# currency-check.sh — wöchentlicher Upstream-Currency-Check für den owlOS/CloudflareOS-Fork.
# OWL-1570 (AC5 aus OWL-1566). Baut auf drift-report.sh (OWL-1567) auf, ersetzt es nicht.
#
# Ablauf (REIN LESEND gegen das ÖFFENTLICHE cloudflare/cloudflare-os):
#   1. git fetch upstream (read-only, public)
#   2. drift-report.sh -> menschenlesbarer, nach Security/kritisch vs. sonstige kategorisierter Report
#   3. ermittelt KRITISCHE Commits seit gepinntem UPSTREAM_VERSION
#   4. >=1 kritischer Commit -> legt genau EIN Paperclip-Sync-Issue an (idempotent per Fingerprint)
#   5. kein kritischer Drift -> nur Log, kein Issue
#
# HARTE ACCOUNT-GRENZE (OWL-1434/OWL-1570): NUR öffentliches Upstream read-only.
# Kein Deploy, kein Token-Antrag, keine fremde Cloudflare-account_id. Netzzugriff =
# ausschliesslich `git fetch` gegen die öffentliche Upstream-URL + Paperclip-API.
#
# Idempotenz: Fingerprint = short-SHA des JÜNGSTEN kritischen Commits seit Pin.
# Vor dem Anlegen wird das Board nach einem Issue mit [currency-sync:<fp>] durchsucht;
# existiert eins -> kein Duplikat. Kommt kein neuer kritischer Commit dazu, bleibt der
# Fingerprint gleich -> kein zweites Issue. Das Board ist der Zustand (kein State-File nötig).
#
# Flags:
#   --dry-run    alles ausser dem Issue-POST (Vorschau / Nachweis "ohne Drift")
#   --no-fetch   git fetch überspringen (offline / bereits gefetcht)
#
# Env-Overrides (optional, v. a. für Nachweis-Läufe):
#   UPSTREAM_PIN_OVERRIDE   Basis-Ref statt UPSTREAM_REF aus UPSTREAM_VERSION
#   CURRENCY_PROJECT_ID / CURRENCY_PARENT_ID / CURRENCY_ASSIGNEE_AGENT_ID
#
set -euo pipefail

DRY_RUN=0; DO_FETCH=1
for a in "$@"; do
  case "$a" in
    --dry-run)  DRY_RUN=1 ;;
    --no-fetch) DO_FETCH=0 ;;
    *) echo "unbekanntes Flag: $a" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
SCRIPT_DIR="vonbusch/scripts"

# --- UPSTREAM_VERSION laden ---
[ -f UPSTREAM_VERSION ] || { echo "FEHLER: UPSTREAM_VERSION fehlt" >&2; exit 1; }
PIN="${UPSTREAM_PIN_OVERRIDE:-$(grep '^UPSTREAM_REF=' UPSTREAM_VERSION | cut -d= -f2)}"
UP_URL="$(grep '^UPSTREAM_REMOTE=' UPSTREAM_VERSION | cut -d= -f2)"
: "${PIN:?UPSTREAM_REF fehlt}" "${UP_URL:?UPSTREAM_REMOTE fehlt}"

# --- Account-Grenze: Upstream MUSS das öffentliche Cloudflare-Repo sein ---
EXPECT_UP="https://github.com/cloudflare/cloudflare-os.git"
if [ "$UP_URL" != "$EXPECT_UP" ]; then
  echo "STOPP (Account-Grenze): UPSTREAM_REMOTE '$UP_URL' != '$EXPECT_UP'" >&2; exit 3
fi
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$EXPECT_UP"
CUR_UP="$(git remote get-url upstream)"
if [ "$CUR_UP" != "$EXPECT_UP" ]; then
  echo "STOPP (Account-Grenze): upstream-Remote '$CUR_UP' != '$EXPECT_UP'" >&2; exit 3
fi

if [ "$DO_FETCH" = 1 ]; then
  echo "→ git fetch upstream (read-only) …" >&2
  git fetch upstream --no-tags --quiet
fi

HEAD_SHORT="$(git rev-parse --short upstream/main)"
PIN_SHORT="$(git rev-parse --short "$PIN")"

echo "===================================================================" >&2
echo " CURRENCY-CHECK  (Pin $PIN_SHORT  →  upstream/main $HEAD_SHORT)" >&2
echo "===================================================================" >&2

echo "→ Drift-Report (drift-report.sh, kategorisiert):" >&2
LOCAL_REF="$PIN" UPSTREAM_REF="upstream/main" bash "$SCRIPT_DIR/drift-report.sh" --no-fetch || true

# --- kritische Commits seit Pin ---
# ponytail: Regex spiegelt drift-report.sh Kategorie (a). Bei Änderung dort hier mitziehen.
CRIT_RE='secur|vuln|cve|overflow|leak|crash|panic|deadlock|race\b|bound|recover|reconnect|\bfix\b|hotfix|revert'
CRIT_COMMITS="$(git log --no-merges --reverse --format='%H|%s' "$PIN..upstream/main" \
  | while IFS='|' read -r sha subj; do
      lc="$(printf '%s' "$subj" | tr '[:upper:]' '[:lower:]')"
      printf '%s' "$lc" | grep -qE "$CRIT_RE" && printf '%s|%s\n' "$sha" "$subj" || true
    done)"

CRIT_COUNT="$(printf '%s' "$CRIT_COMMITS" | grep -c '|' || true)"
CRIT_COUNT="${CRIT_COUNT:-0}"

if [ "$CRIT_COUNT" -eq 0 ]; then
  echo "✓ Kein kritischer Upstream-Drift seit Pin $PIN_SHORT (HEAD $HEAD_SHORT). Kein Issue." >&2
  exit 0
fi

FP_FULL="$(printf '%s\n' "$CRIT_COMMITS" | tail -1 | cut -d'|' -f1)"
FP="$(git rev-parse --short "$FP_FULL")"
MARKER="currency-sync:$FP"
DIFF_LINK="https://github.com/cloudflare/cloudflare-os/compare/${PIN_SHORT}...${HEAD_SHORT}"

echo "→ $CRIT_COUNT kritische(r) Commit(s); Fingerprint [$MARKER]" >&2

# --- API-Kontext ---
API="${PAPERCLIP_API_URL:-}"; KEY="${PAPERCLIP_API_KEY:-}"; CID="${PAPERCLIP_COMPANY_ID:-}"
PROJECT_ID="${CURRENCY_PROJECT_ID:-07cfa4a4-5ef3-47a3-beda-4347d4ca6ba7}"
PARENT_ID="${CURRENCY_PARENT_ID:-dc6a4d3f-da4c-4b5d-a1e8-825b504400a9}"   # OWL-1566
ASSIGNEE="${CURRENCY_ASSIGNEE_AGENT_ID:-${PAPERCLIP_AGENT_ID:-}}"

# --- Idempotenz: existiert schon ein Sync-Issue mit diesem Fingerprint? ---
if [ -n "$API" ] && [ -n "$KEY" ] && [ -n "$CID" ]; then
  EXISTS="$(curl -s -H "Authorization: Bearer $KEY" \
      "$API/api/companies/$CID/issues?q=$MARKER" \
    | MARKER="$MARKER" python3 -c '
import sys,json,os
m=os.environ["MARKER"]
try: d=json.load(sys.stdin)
except Exception: print(0); sys.exit(0)
items=d if isinstance(d,list) else d.get("issues",d.get("items",[]))
print(sum(1 for i in items if m in ((i.get("title") or "")+(i.get("description") or ""))))
' 2>/dev/null || echo 0)"
  if [ "${EXISTS:-0}" != 0 ]; then
    echo "✓ Idempotent: Sync-Issue mit [$MARKER] existiert bereits ($EXISTS). Kein Duplikat." >&2
    exit 0
  fi
fi

# --- Issue-Body bauen ---
BODY="$(PIN_SHORT="$PIN_SHORT" HEAD_SHORT="$HEAD_SHORT" DIFF_LINK="$DIFF_LINK" \
  MARKER="$MARKER" CRIT_COUNT="$CRIT_COUNT" CRIT_COMMITS="$CRIT_COMMITS" python3 -c '
import os
crit=[l for l in os.environ["CRIT_COMMITS"].splitlines() if "|" in l]
lines=[]
for l in crit:
    sha,subj=l.split("|",1)
    lines.append(f"- `{sha[:9]}` {subj}")
print(f"""## Upstream-Currency: kritischer Drift erkannt

Automatischer wöchentlicher Currency-Check ([OWL-1570](/OWL/issues/OWL-1570), Routine `currency-check.sh`).

- Basis (gepinnt): `{os.environ["PIN_SHORT"]}` — siehe `UPSTREAM_VERSION`
- Upstream `cloudflare/cloudflare-os` HEAD: `{os.environ["HEAD_SHORT"]}`
- Kritische Commits seit Pin: **{os.environ["CRIT_COUNT"]}**
- Diff: {os.environ["DIFF_LINK"]}
- Fingerprint: `[{os.environ["MARKER"]}]`

### Kritische / Security-relevante Commits (Kategorie a)
""" + "\n".join(lines) + f"""

### Nächster Schritt (Founding Engineer)
Kritische Commits gemäss `docs/UPGRADING.md` selektiv prüfen & cherry-picken
(`git cherry-pick -x <sha>`), Entscheidung in `vonbusch/FORK-SYNC.md` registrieren,
danach `UPSTREAM_VERSION` fortschreiben. Read-only, kein fremder Account.

_Read-only gegen öffentliches Upstream. Kein Deploy, kein Token, keine fremde account_id._
_Parent: [OWL-1566](/OWL/issues/OWL-1566)._""")
')"

TITLE="CloudflareOS-Fork Upstream-Sync: $CRIT_COUNT kritische Commit(s) [$MARKER]"

if [ "$DRY_RUN" = 1 ]; then
  echo "── DRY-RUN: würde folgendes Issue anlegen ──" >&2
  echo "Titel: $TITLE"
  echo "$BODY"
  exit 0
fi

if [ -z "$API" ] || [ -z "$KEY" ] || [ -z "$CID" ]; then
  echo "FEHLER: PAPERCLIP_API_URL/KEY/COMPANY_ID fehlen — kann Issue nicht anlegen." >&2
  echo "(Report oben ist gültig; im Heartbeat mit gesetzten Env-Vars erneut laufen lassen.)" >&2
  exit 4
fi

PAYLOAD="$(TITLE="$TITLE" BODY="$BODY" PROJECT_ID="$PROJECT_ID" PARENT_ID="$PARENT_ID" \
  ASSIGNEE="$ASSIGNEE" python3 -c '
import os,json
p={"title":os.environ["TITLE"],"description":os.environ["BODY"],
   "projectId":os.environ["PROJECT_ID"],"parentId":os.environ["PARENT_ID"],
   "priority":"high","status":"todo"}
a=os.environ.get("ASSIGNEE")
if a: p["assigneeAgentId"]=a
print(json.dumps(p))
')"

RESP="$(curl -s -X POST "$API/api/companies/$CID/issues" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  ${PAPERCLIP_RUN_ID:+-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"} \
  --data "$PAYLOAD")"

NEW_ID="$(printf '%s' "$RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);i=d.get("issue",d);print(i.get("identifier") or i.get("id") or "?")' 2>/dev/null || echo '?')"
echo "✓ Sync-Issue angelegt: $NEW_ID  [$MARKER]" >&2
echo "$NEW_ID"
