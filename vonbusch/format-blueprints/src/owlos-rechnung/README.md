# Rechnung anlegen — owlOS-Workflow-Blueprint

Ein teilbarer Blueprint statt eines Copy-&-Paste-Einzelprompts. Wer ihn instanziiert, bekommt ein
kleines Gadget mit einem Formular (Kunde + Positionen) und einem Knopf. Ein Klick spawnt einen
KI-Agenten mit dem festen Rechnungs-Anlage-Workflow gegen die verbundene owlOS-Instanz.

## Bindings

| Binding    | Typ                        | Zweck |
| ---------- | -------------------------- | ----- |
| `WORKFLOW` | agentSpawner               | spawnt den Rechnungs-Agenten; beim Instanziieren wählt der Nutzer nur das Modell |
| `owlos`    | gatekeeper (spawnerOnly)   | owlOS-Gatekeeper, in die env des Agenten gereicht — Reads direkt, Creates approval-pflichtig |

`owlos` ist `spawnerOnly`: der Gatekeeper wird **nicht** an das Gadget selbst gebunden, sondern nur
in die Umgebung des gespawnten Agenten. Das Gadget kennt nur `env.WORKFLOW`. Der `owlos`-Gatekeeper
(+ `GATEKEEPER_OWLOS` auf Backend + Router) existiert bereits live aus S1 (OWL-1647) — S2 fügt kein
neues Binding hinzu.

## owlOS-Endpunkte (aus `packages/gatekeeper-owlos/S2-CONTRACT.md`)

- `GET  /api/faktura/outgoing` — Ausgangsrechnungen lesen (direkt)
- `POST /api/faktura/outgoing { doc_type, … }` — Rechnungskopf anlegen (approval-pflichtig)
- `POST /api/faktura/outgoing/{id}/items` — Positionen hinzufügen (approval-pflichtig)
- `POST /api/faktura/outgoing/{id}/finalize` — Rechnung finalisieren (approval-pflichtig)

## Ablauf

1. Nutzer trägt Kunde + Positionen ein und klickt „Rechnung anlegen".
2. `Gadget.launch()` ruft `env.WORKFLOW.spawn(titel, prompt)` mit dem kuratierten Workflow-Prompt.
3. Der Agent liest die Ausgangsrechnungen, legt den Rechnungskopf approval-pflichtig an, ergänzt die
   Positionen und finalisiert erst nach Freigabe.

Der Workflow-Prompt lebt in `server.js` (`buildPrompt`) — das ist der eigentliche Wert dieses
Blueprints. Er nennt dem Agenten ausschließlich die oben gelisteten owlOS-Routen; nichts wird
geraten (RATEN VERBOTEN).
