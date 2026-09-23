# Ansprechpartner anlegen — owlOS-Workflow-Blueprint

Ein teilbarer Blueprint statt eines Copy-&-Paste-Einzelprompts. Wer ihn instanziiert, bekommt ein
kleines Gadget mit einem Formular (Firma + Vor-/Nachname + optionale Details) und einem Knopf. Ein
Klick spawnt einen KI-Agenten mit dem festen Kontakt-Anlage-Workflow gegen die verbundene
owlOS-Instanz.

## Bindings

| Binding    | Typ                        | Zweck |
| ---------- | -------------------------- | ----- |
| `WORKFLOW` | agentSpawner               | spawnt den Kontakt-Agenten; beim Instanziieren wählt der Nutzer nur das Modell |
| `owlos`    | gatekeeper (spawnerOnly)   | owlOS-Gatekeeper, in die env des Agenten gereicht — Reads direkt, Creates approval-pflichtig |

`owlos` ist `spawnerOnly`: der Gatekeeper wird **nicht** an das Gadget selbst gebunden, sondern nur
in die Umgebung des gespawnten Agenten. Der `owlos`-Gatekeeper (+ `GATEKEEPER_OWLOS` auf Backend +
Router) existiert bereits live aus S1 (OWL-1647) — S2 fügt kein neues Binding hinzu.

## owlOS-Endpunkte (aus `packages/gatekeeper-owlos/S2-CONTRACT.md`, aus dem SPA-Bundle verifiziert)

- `GET  /api/companies` — Firmenliste lesen, um `company_id` aufzulösen (direkt)
- `GET  /api/contacts?company_id={id}` / `?search={text}` — Kontakte/Dubletten lesen (direkt)
- `POST /api/contacts { company_id, first_name, last_name, email, phone, position, status:"prospect", is_decision_maker:0 }`
  — Kontakt anlegen; `company_id`, `first_name`, `last_name` sind **Pflicht** (approval-pflichtig)
- `POST /api/contacts/merge` — Dubletten zusammenführen (approval-pflichtig)

## Ablauf

1. Nutzer trägt Firma + Vor-/Nachname (+ optional E-Mail/Telefon/Position) ein und klickt
   „Ansprechpartner anlegen".
2. `Gadget.launch()` ruft `env.WORKFLOW.spawn(titel, prompt)` mit dem kuratierten Workflow-Prompt.
3. Der Agent löst die Firma zu einer `company_id` auf, prüft auf Dubletten und legt den Kontakt mit
   den drei Pflichtfeldern approval-pflichtig an.

Der Workflow-Prompt lebt in `server.js` (`buildPrompt`) — das ist der eigentliche Wert dieses
Blueprints. Er nennt dem Agenten ausschließlich die oben gelisteten owlOS-Routen und die exakt aus
`index-BISW9feO.js` extrahierten Pflichtfelder; nichts wird geraten (RATEN VERBOTEN).
