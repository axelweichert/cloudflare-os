# JustIn-ERP-Gatekeeper (vonBuschOS · VON-1804 · K3)

Macht das **JustIn-ERP** als **capability-basierte Ressourcen** im Gadgets-Workshop
verfügbar. Rechnungen, Aufträge und Bestände sind **read-only** direkt lesbar; die
einzige mutierende Aktion — **„Angebot erstellen"** — läuft ausschließlich über eine
**menschliche Freigabe-Queue** (Human-in-the-Loop). „Auftragsstatus prüfen" ist eine
reine Leseauskunft und daher **nicht** freigabepflichtig.

## Fähigkeiten (MCP-Tools)

| Tool | Art | Zweck |
|------|-----|-------|
| `list_invoices([search],[customerId],[status],[limit],[offset])` | Read (`readOnlyHint`) | Rechnungen |
| `list_orders([search],[customerId],[status],[limit],[offset])` | Read (`readOnlyHint`) | Aufträge |
| `get_order_status(orderId)` | Read (`readOnlyHint`) | **Auftragsstatus prüfen** (kein Seiteneffekt) |
| `list_inventory([search],[limit],[offset])` | Read (`readOnlyHint`) | Bestände |
| `propose_quote(customerId, lines, [note], [validUntil], [reason])` | **Approval** | **Angebot erstellen** → Queue |
| `list_my_proposals()` | Read | Status eigener Vorschläge |

`lines` = `[{ sku, qty, [unitPrice] }]`. Fehlt `unitPrice`, kalkuliert das ERP aus
den Stammdaten.

## Sicherheitsmodell (Human-in-the-Loop)

- **Lesen** ist gefahrlos und direkt erlaubt (`readOnlyHint: true` auf jedem Read-Tool).
- **`propose_quote`** schreibt **nie** direkt: der Vorschlag landet als `pending` in der
  DO-gestützten Approval-Queue. Ein Mensch (hinter **CF Access**) sieht die Queue unter
  `GET /` und gibt frei/lehnt ab. Erst bei Freigabe ruft der Worker `createQuote` gegen
  das reale ERP auf.
- Validierungs-Invarianten (`quote-queue.ts`): `customerId` Pflicht, nicht-leere
  Positionen mit `qty > 0` / `unitPrice >= 0`, Obergrenzen gegen Mega-Angebote, kein
  Doppel-Approve / kein Doppel-Write (nur `pending` entscheidbar, nur `approved`
  ausführbar).
- Agenten-Auth an `/mcp` per internem `API_KEY` (Bearer/`X-API-Key`); die Freigabe-UI
  ist über CF Access separat geschützt.

## Routen

| Route | Zweck |
|-------|-------|
| `POST /mcp` | MCP (Reads direkt, `propose_quote` queued) |
| `GET /` | HTML-Freigabe-UI (Mensch, CF-Access-gated) |
| `GET /api/queue[?status=…]` | JSON-Liste der Vorschläge |
| `POST /api/queue/:id/approve` | freigeben → Angebot im ERP anlegen |
| `POST /api/queue/:id/reject` | ablehnen |

## ⚠️ ERP-API-Oberfläche/Auth — Wiring-Gate (CEO)

Das Issue verlangt: *„ERP-API-Oberfläche/Auth vorab klären. Bindings: ERP-Endpoint+Token."*
Diese Schnittstelle ist **noch unbestätigt**. Der Gatekeeper ist deshalb hinter einem
austauschbaren Adapter (`ErpAdapter`) gebaut und **vollständig gegen den
`MemoryErpAdapter` getestet**. `HttpErpAdapter` kodiert eine **explizite Annahme**:

- **REST/JSON** über eine Basis-URL (`ERP_ENDPOINT`).
- **Bearer-Token**-Auth (`ERP_TOKEN`).
- Pfade/Feld-Mapping laut `DEFAULT_JUSTIN_PROFILE` (`GET /invoices`, `GET /orders`,
  `GET /orders/{id}/status`, `GET /inventory`, `POST /quotes`) — jederzeit ohne
  Kern-Änderung über ein anderes `ErpHttpProfile` austauschbar (z.B. SOAP-Bridge,
  abweichende Feldnamen, andere Auth).

**Vor Prod muss der CEO klären:**
1. Reale JustIn-Basis-URL und Auth-Mechanismus (Bearer? API-Key-Header? OAuth? mTLS?).
2. Endpunkt-Pfade und Response-Shape (→ ggf. `ErpHttpProfile` anpassen).
3. Payload-Format für „Angebot erstellen".
4. Ob eine Netzwerk-Route zum ERP von der CF-Kante besteht (Tunnel/öffentliche API?).

## Deploy (CEO-Gate)

```bash
# 1. ERP_ENDPOINT in wrangler.jsonc auf die echte Basis-URL setzen (var)
# 2. Secrets:
wrangler secret put ERP_TOKEN -c vonbusch/justin-erp-gatekeeper/wrangler.jsonc
wrangler secret put API_KEY   -c vonbusch/justin-erp-gatekeeper/wrangler.jsonc
# 3. CF Access vor GET / spannen (nur Menschen dürfen freigeben)
wrangler deploy -c vonbusch/justin-erp-gatekeeper/wrangler.jsonc
```

## Tests

```bash
npx tsx --test vonbusch/justin-erp-gatekeeper/erp-gatekeeper.test.ts   # 20 Tests, workerd-frei
```

Deckt: Memory- und Http-Adapter (gegen Fake-`fetch`), Angebots-Validierung &
Queue-Lebenszyklus, den MCP-Server (read-only Reads + approval-pflichtiges
`propose_quote`) und den End-to-End-Pfad Freigabe → `createQuote` im ERP.

## Konventionen (vonbusch/ K-Gatekeeper)

Reiner, speicher-agnostischer Kern (workerd-frei, `npx tsx --test`) + dünner
DO-/Worker-Shim; Reads direkt, Writes über DO-Approval-Queue; `wrangler -c`;
issue-id aus `WAKE_PAYLOAD`. Konsistent mit K2 (CRM) und K5 (Mail).
