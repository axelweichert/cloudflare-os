# Opportunity anlegen — owlOS-Workflow-Blueprint

Ein teilbarer Blueprint statt eines Copy-&-Paste-Einzelprompts. Wer ihn instanziiert, bekommt ein
kleines Gadget mit einem Formular (Titel + Firma + Stufe/Wert) und einem Knopf. Ein Klick spawnt
einen KI-Agenten mit dem festen Opportunity-Anlage-Workflow gegen die verbundene owlOS-Instanz.
owlOS nennt Opportunities intern **Deals**.

## Bindings

| Binding    | Typ                        | Zweck |
| ---------- | -------------------------- | ----- |
| `WORKFLOW` | agentSpawner               | spawnt den Opportunity-Agenten; beim Instanziieren wählt der Nutzer nur das Modell |
| `owlos`    | gatekeeper (spawnerOnly)   | owlOS-Gatekeeper, in die env des Agenten gereicht — Reads direkt, Creates approval-pflichtig |

`owlos` ist `spawnerOnly` — nicht ans Gadget gebunden, nur in die env des gespawnten Agenten
gereicht. Der `owlos`-Gatekeeper (+ `GATEKEEPER_OWLOS`) existiert bereits live aus S1 (OWL-1647).

## owlOS-Endpunkte (aus `packages/gatekeeper-owlos/S2-CONTRACT.md`, aus dem SPA-Bundle verifiziert)

- `GET  /api/auth/me` — eingeloggten Nutzer + `owner_id` ermitteln (Pflicht für die Anlage)
- `GET  /api/companies` — Firma auflösen (`company_id`) (direkt)
- `GET  /api/deals?company_id=|?status=open`, `GET /api/deals/pipeline` — Deals/Pipeline lesen (direkt)
- `POST /api/deals { title, company_id, owner_id, stage, value, probability }`
  — Deal anlegen; `title` und `owner_id` sind **Pflicht** (approval-pflichtig)

Gültige `stage`-Werte (aus dem Bundle): lead (Erstkontakt), qualified (Qualifiziert),
proposal (Angebot), negotiation (Verhandlung), won (Gewonnen).

## Ablauf

1. Nutzer trägt Titel + Firma (+ optional Stufe/Wert/Wahrscheinlichkeit) ein und klickt
   „Opportunity anlegen".
2. `Gadget.launch()` ruft `env.WORKFLOW.spawn(titel, prompt)` mit dem kuratierten Workflow-Prompt.
3. Der Agent ermittelt `owner_id` via `/api/auth/me`, löst die Firma auf und legt den Deal mit den
   Pflichtfeldern approval-pflichtig an.

Der Workflow-Prompt lebt in `server.js` (`buildPrompt`) — er nennt dem Agenten ausschließlich die
oben gelisteten owlOS-Routen und die exakt aus `index-BISW9feO.js` extrahierten Pflichtfelder;
nichts wird geraten (RATEN VERBOTEN).
