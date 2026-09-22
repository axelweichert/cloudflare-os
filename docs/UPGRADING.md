# CloudflareOS-Fork — Upgrade-Runbook (owlOS)

**Board:** [OWL-1567](/OWL/issues/OWL-1567) · **Eltern:** [OWL-1566](/OWL/issues/OWL-1566)
**Zweck:** Wie wir den owlOS-Fork auf eine neuere Version von
`cloudflare/cloudflare-os` heben, **ohne** unsere Erweiterungen zu verlieren.

Dieses Runbook ist die owlOS-Sicht. Die DE-Lokalisierungs-Details und die
Null-Verlust-Garantie stehen in [`vonbusch/FORK-SYNC.md`](../vonbusch/FORK-SYNC.md);
dort gilt alles **außer** dem Cherry-pick-/merge-base-Teil — siehe Korrektur unten.

---

## ⚠️ Topologie-Korrektur (CTO, OWL-1566)

`origin/main` ist ein **Snapshot-Fork OHNE gemeinsame Historie** mit Upstream:

```bash
$ git merge-base HEAD upstream/main
# (leer, exit 1)  → kein gemeinsamer Vorfahre
```

Damit passt der SHA-`cherry-pick -x`- / merge-base-Ansatz aus `FORK-SYNC.md`
**nicht** auf diese Topologie. Ein `git merge upstream/main` oder
`git cherry-pick` würde auf tausenden nicht-verwandten Dateien kollidieren.

**Korrekter Ansatz: Overlay-Re-apply statt Merge.** Wir behandeln Upstream als
neue Basis und tragen unsere überschaubare Overlay-Menge (owlOS-Gatekeeper +
DE-Lokalisierung) darauf erneut auf. Die owlOS-Gatekeeper berühren den
Upstream-Kern an **genau drei** Stellen (Seam-Register unten) — alles andere ist
additiv (neue `packages/gatekeeper-*/`-Verzeichnisse).

---

## Seam-Register — die genau 3 erlaubten Upstream-Kern-Berührpunkte

Nur diese drei Upstream-Dateien werden von den owlOS-Gatekeepern **verändert**.
Beim Overlay-Re-apply müssen exakt diese drei Nähte erneut gesetzt werden; der
Naht-Wächter `scripts/owlos-guard.sh` verifiziert alle drei in CI.

| # | Upstream-Kern-Datei | Naht (was owlOS hinzufügt) | Guard-Check |
|---|---|---|---|
| 1 | `scripts/release/manifest-lib.ts` | `gatekeeper-unifi` + `gatekeeper-homeassistant` im `NO_DEFAULT_CRED_INPUTS`-Set (beide bringen Credentials in-app mit, kein zentraler OAuth-App-Secret) | Naht A |
| 2 | `scripts/release/testdata/golden-manifest.json` | beide Worker-Einträge (Key + `shortName` + `BASE_URL`-Route `/gatekeeper/<sn>`) im generierten Manifest-Snapshot | Naht B |
| 3 | `packages/router/__tests__/router.test.ts` | Routen-Assertion `/gatekeeper/unifi/*` + `/gatekeeper/homeassistant/*` → richtiger Fetcher | Naht C |

**Additiv, keine Naht** (fallen bei Verlust sofort auf, brauchen keinen Guard):
`packages/gatekeeper-unifi/**`, `packages/gatekeeper-homeassistant/**`,
`scripts/release/testdata/fixture-bundles/gatekeeper-*/` (Golden-Test-Fixtures).

> **Router-Hinweis:** Der Router selbst hat **keine** hartkodierte Gatekeeper-Route
> — er entdeckt Gatekeeper dynamisch über `GATEKEEPER_*`-Env-Keys. Deshalb ist die
> dritte Naht der Test, nicht Produktionscode: Ein neuer Gatekeeper ist im Router
> „automatisch" verdrahtet, sobald sein Binding im Manifest steht (Naht 2).

---

## Der 5-Schritt-Upgrade-Prozess (Plan §3, OWL-1566)

Alles auf einem `sync/*`-Branch. **Nie** direkt auf `main` mergen/resetten
(siehe verbotene Befehle in `FORK-SYNC.md`). **Kein Deploy** ohne Board-Gate.

### Schritt 1 — Pin & Sicherungspunkt
```bash
git fetch upstream --no-tags
# Ziel-Ref aus UPSTREAM_VERSION lesen (aktuell f961c844…) oder neuere wählen:
UPSTREAM_REF=$(grep '^UPSTREAM_REF=' UPSTREAM_VERSION | cut -d= -f2)
git tag "owlos/pre-sync-$(date +%Y%m%d)"      # unveränderlicher Rückfallpunkt
git switch -c "sync/upstream-$UPSTREAM_REF"
```

### Schritt 2 — Overlay identifizieren
Unsere Overlay-Menge = alles, was NICHT reiner Upstream ist:
- additiv: `packages/gatekeeper-unifi/`, `packages/gatekeeper-homeassistant/`,
  `vonbusch/`, `docs/UPGRADING.md`, `scripts/owlos-guard.sh`, `UPSTREAM_VERSION`,
  DE-lokalisierte Dateien.
- Nähte: die 3 Dateien aus dem Seam-Register.
```bash
vonbusch/scripts/drift-report.sh   # zeigt, was gegenüber upstream/main abweicht
```

### Schritt 3 — Upstream als neue Basis übernehmen
Snapshot-Overlay: Upstream-Kern-Stand in den Sync-Branch spiegeln, unsere
additiven Pfade unangetastet lassen. (Kein `merge`/`cherry-pick` — merge-base ist
leer.) Praktisch: Upstream-Baum an den Nicht-Overlay-Pfaden übernehmen, danach
Overlay + die 3 Nähte re-applyen.

### Schritt 4 — Nähte re-applyen & Guards grün
```bash
scripts/owlos-guard.sh --verbose       # alle 3 Nähte vorhanden?
vonbusch/scripts/fork-guard.sh --verbose
pnpm build                             # tsc + Bundles (enthält types:check)
pnpm test                              # inkl. manifest-lib.test.ts (Golden==Generat)
```
Rot → fehlende Naht aus dem Register nachtragen, wiederholen.

### Schritt 5 — Review & Gate
Sync-Branch als PR öffnen. Beide Guards + Build + Test müssen grün sein.
`UPSTREAM_VERSION` auf die neue Ref aktualisieren. Merge/Deploy erst nach
Board-/CTO-Gate (Account-Grenze prüfen: nur unsere Accounts, nie fremde
Cloudflare-IDs — siehe OWL-1434 / OWL-1567).

---

## Verweise
- Null-Verlust-Garantie, verbotene Befehle, DE-Marker: [`vonbusch/FORK-SYNC.md`](../vonbusch/FORK-SYNC.md)
- Naht-Wächter: [`scripts/owlos-guard.sh`](../scripts/owlos-guard.sh) (CI: `.github/workflows/ci.yml`, Job `fork-guard`)
- Upstream-Pin: [`UPSTREAM_VERSION`](../UPSTREAM_VERSION)
- Drift-Report: [`vonbusch/scripts/drift-report.sh`](../vonbusch/scripts/drift-report.sh)
