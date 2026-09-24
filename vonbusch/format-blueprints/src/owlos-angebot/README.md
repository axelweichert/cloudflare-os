# Angebot anlegen — owlOS-Workflow-Blueprint

Ein teilbarer Blueprint statt eines Copy-&-Paste-Einzelprompts. Wer ihn instanziiert, bekommt ein
kleines Gadget mit einem Formular (Titel + Kunde) und einem Knopf. Ein Klick spawnt einen
KI-Agenten mit dem festen Angebots-Anlage-Workflow gegen die verbundene owlOS-Instanz.

## Bindings

| Binding    | Typ                        | Zweck |
| ---------- | -------------------------- | ----- |
| `WORKFLOW` | agentSpawner               | spawnt den Angebots-Agenten; beim Instanziieren wählt der Nutzer nur das Modell |
| `owlos`    | gatekeeper (spawnerOnly)   | owlOS-Gatekeeper, in die env des Agenten gereicht — Reads direkt, Creates approval-pflichtig |

`owlos` ist `spawnerOnly`: der Gatekeeper wird **nicht** an das Gadget selbst gebunden, sondern nur
in die Umgebung des gespawnten Agenten. Das Gadget kennt nur `env.WORKFLOW`. Der `owlos`-Gatekeeper
(+ `GATEKEEPER_OWLOS` auf Backend + Router) existiert bereits live aus S1 (OWL-1647) — S2 fügt kein
neues Binding hinzu.

## owlOS-Endpunkte (aus `packages/gatekeeper-owlos/S2-CONTRACT.md`)

- `GET  /api/erp/quotes` — Angebotsliste lesen (direkt)
- `POST /api/erp/quotes { title }` — Angebot anlegen; `title` ist Pflicht (approval-pflichtig)
- `PATCH /api/erp/quotes/{id}` — `company_id` (u. a.) setzen (approval-pflichtig)

## Ablauf

1. Nutzer trägt Titel (+ optional Kunde) ein und klickt „Angebot anlegen".
2. `Gadget.launch()` ruft `env.WORKFLOW.spawn(titel, prompt)` mit dem kuratierten Workflow-Prompt.
3. Der Agent liest die Angebotsliste, legt das Angebot mit Pflicht-Titel approval-pflichtig an und
   verknüpft es per PATCH mit dem Kunden (`company_id`).

Der Workflow-Prompt lebt in `server.js` (`buildPrompt`) — das ist der eigentliche Wert dieses
Blueprints. Er nennt dem Agenten ausschließlich die oben gelisteten owlOS-Routen; nichts wird
geraten (RATEN VERBOTEN).
