# Aktivität festhalten — owlOS-Workflow-Blueprint

Ein teilbarer Blueprint statt eines Copy-&-Paste-Einzelprompts. Wer ihn instanziiert, bekommt ein
kleines Gadget mit einem Formular (Betreff + Typ + optionale Notiz/Zuordnung) und einem Knopf. Ein
Klick spawnt einen KI-Agenten mit dem festen Aktivitäten-Workflow gegen die verbundene
owlOS-Instanz.

## Bindings

| Binding    | Typ                        | Zweck |
| ---------- | -------------------------- | ----- |
| `WORKFLOW` | agentSpawner               | spawnt den Aktivitäten-Agenten; beim Instanziieren wählt der Nutzer nur das Modell |
| `owlos`    | gatekeeper (spawnerOnly)   | owlOS-Gatekeeper, in die env des Agenten gereicht — Reads direkt, Creates approval-pflichtig |

`owlos` ist `spawnerOnly` — nicht ans Gadget gebunden, nur in die env des gespawnten Agenten
gereicht. Der `owlos`-Gatekeeper (+ `GATEKEEPER_OWLOS`) existiert bereits live aus S1 (OWL-1647).

## owlOS-Endpunkte (aus `packages/gatekeeper-owlos/S2-CONTRACT.md`, aus dem SPA-Bundle verifiziert)

- `GET  /api/auth/me` — eingeloggten Nutzer + `owner_id` ermitteln (Pflicht für die Anlage)
- `GET  /api/companies`, `GET /api/contacts?company_id=|?search=` — Firma/Kontakt auflösen (direkt)
- `GET  /api/activities?company_id=|?contact_id=`, `GET /api/activities/kanban` — Aktivitäten lesen (direkt)
- `POST /api/activities { type, subject, body, company_id, contact_id, owner_id, status:"open" }`
  — Aktivität anlegen; `subject` und `owner_id` sind **Pflicht** (approval-pflichtig)
- `PATCH /api/activities/{id}/status` — Status (open/done) ändern (approval-pflichtig)

Gültige `type`-Werte (aus dem Bundle): Brief, E-Mail, Angebot, Auftrag, Auftragsbestätigung,
Rechnung, Lieferschein, Gutschrift, Mahnung, Vertrag, Korrespondenz, Notiz, Sonstige.

## Ablauf

1. Nutzer trägt Betreff + Typ (+ optional Text/Firma/Kontakt) ein und klickt „Aktivität festhalten".
2. `Gadget.launch()` ruft `env.WORKFLOW.spawn(titel, prompt)` mit dem kuratierten Workflow-Prompt.
3. Der Agent ermittelt `owner_id` via `/api/auth/me`, löst Firma/Kontakt auf und legt die Aktivität
   mit den Pflichtfeldern approval-pflichtig an.

Der Workflow-Prompt lebt in `server.js` (`buildPrompt`) — er nennt dem Agenten ausschließlich die
oben gelisteten owlOS-Routen und die exakt aus `index-BISW9feO.js` extrahierten Pflichtfelder;
nichts wird geraten (RATEN VERBOTEN).
