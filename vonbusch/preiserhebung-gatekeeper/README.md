# Preiserhebungs-Gatekeeper (vonBuschOS · VON-1801)

Macht die bestehenden Preis-/Kalkulationslogiken der Firma als **read-only
Gadget-Baustein** im Gadgets-Workshop verfügbar. Der Vertrieb baut daraus
interaktive Kalkulatoren und justiert Parameter selbst — **ohne** die
Preis-Quelle zu verändern.

## Warum

Zwei erprobte Rechenkerne existieren bereits, aber jeweils fest in ihrer App:

- **printgemein-Druckpreis** — affin-lineare Preis-Engine (Rüstkosten, Klick-,
  Papier-, Weiterverarbeitungs-, Versandkosten, Provision, MwSt). Quelle:
  `printgemein/src/pricing/engine.ts` (VON-32).
- **DMS-ROI** — Prozesskosten-/Amortisationsmodell (Zeit-, Papier-, Archiv-,
  Fehlerersparnis, ROI je Horizont). Quelle: `dmsroi/roi-config.js`
  (VON-1785/1787).

Dieser Gatekeeper portiert beide 1:1 (reine, getestete Funktionen) und
exponiert sie als Session-Tools, die ein Gadget aufruft.

## Read-only + „selbst anpassen“

Der kanonische Parametersatz liegt in der **Preis-D1** (`preisparameter`,
Key-Value). Der Gatekeeper liest ihn **ausschließlich lesend**:

1. **Code** — `PreisRepo` bietet keine Schreibmethode; der Worker führt nur
   `SELECT`s aus. Keine `INSERT/UPDATE/DELETE`.
2. **Deploy** — das gebundene D1/API-Token wird auf Leserechte beschränkt
   (CF-Account-Aktion → CEO-Gate).

Der Vertrieb passt trotzdem an: pro Aufruf legt ein `overrides`-Patch ein
„Was-wäre-wenn“ über den Basis-Satz (`wendeOverridesAn`/`mergeOverrides`). Das
ist **nicht persistent** — die D1-Quelle bleibt unangetastet.

## Session-Oberfläche (`session.ts`)

| Tool | Art | Zweck |
|------|-----|-------|
| `getDruckparameter(overrides?)` | Read | kanonischer Druck-Parametersatz aus D1 |
| `berechneDruckPreis(konfiguration, overrides?)` | Read | printgemein-Preisaufschlüsselung |
| `getDmsRoiConfig(overrides?)` | Read | DMS-ROI-Koeffizienten + Defaults |
| `berechneDmsRoi(eingabe, overrides?)` | Read | ROI-Kennzahlen (Ersparnis, Payback, ROI je Horizont) |

Alle Methoden sind **Observations** (Reads) — keine Actions, kein Approval-Queue
nötig (Strategy D, low-stakes). Genau das passt zum read-only-D1-Charakter.

## D1-Key-Konvention (`preis-parameter.ts`)

```
ruestkosten · weiterverarbeitung · margenAufschlag · provisionRate · ust
klickpreis_<4c|sw>
papierpreis_<sorte>_<format>      (format = letztes Segment, z.B. _standard_75_A4)
seitenProBlatt_<A4|A5>
versandkosten_<standard|express>
```

Fehlende Keys fallen auf `PLATZHALTER_PARAMETER` zurück (Resilienz gegen
Teil-Seeds), unbekannte Keys werden ignoriert (Vorwärtskompatibilität).

## HTTP-Smoke (E2E unter `wrangler dev`)

```
GET  /parameter                                   → PreisParameterSatz
POST /calc/druck  { konfiguration, overrides? }   → PreisAufschluesselung
POST /calc/roi    { eingabe, overrides? }         → DmsRoiErgebnis
```

Die eigentliche Gadget-Anbindung läuft über die RPC-`PreiserhebungSession`; die
HTTP-Routen dienen nur der lokalen Verifikation.

## Test (workerd-frei, kostenfrei)

```
npx tsx --test vonbusch/preiserhebung-gatekeeper/preiserhebung.test.ts
```

8 Tests: Druck-Referenzwert, Validierung, DMS-ROI-Kennzahlen, Payback-Grenzfall,
D1-Row-Mapping, Override-Isolation (Quelle unverändert), Override-Wirkung.

## Status

PoC / Engines + Mapping + Session + Tests grün. Offen (Board-/CEO-Gate):

- **Prod-D1-Binding** — echte `database_id` der printgemein-D1 + read-only-Token
  (CF-Account → CEO).
- **Heben in ein vollwertiges `packages/gatekeeper-*`** mit Workshop-Registrierung
  (Vendor/UserImpl/Configurator-UI) statt des schlanken `WorkerEntrypoint`.
  Für einen read-only-Baustein reicht die Low-Stakes-Variante (Strategy D).
