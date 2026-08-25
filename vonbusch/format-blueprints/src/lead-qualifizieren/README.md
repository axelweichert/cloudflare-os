# Lead qualifizieren — Firmen-Workflow-Blueprint

Teilbarer Blueprint statt Einzelprompt. Instanziiert bekommt der Nutzer ein Gadget mit Formular
(Lead + Notiz) und Knopf; ein Klick spawnt einen Agenten mit dem festen BANT-Qualifizierungs-Prompt.

## Bindings

| Binding    | Typ            | Zweck |
| ---------- | -------------- | ----- |
| `WORKFLOW` | agentSpawner   | spawnt den Qualifizierungs-Agenten; beim Instanziieren wählt der Nutzer nur das Modell |
| `crm`      | gatekeeper (spawnerOnly) | CRM-Gatekeeper, in die env des Agenten gereicht — Reads direkt, Writes approval-pflichtig |

## Ablauf

1. Nutzer trägt Lead (+ optionale Notiz) ein und klickt „Qualifizieren".
2. `Gadget.launch()` ruft `env.WORKFLOW.spawn(titel, prompt)` mit dem BANT-Workflow-Prompt.
3. Der Agent liest den Lead (CRM), bewertet Budget/Authority/Need/Timeline, vergibt einen Score
   und legt das Ergebnis als approval-pflichtige CRM-Aktivität an.

Der Workflow-Prompt lebt in `server.js` (`buildPrompt`) — der eigentliche Firmenwert dieses
Blueprints.
