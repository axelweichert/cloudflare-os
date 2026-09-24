# Angebot erstellen — Firmen-Workflow-Blueprint

Ein teilbarer Blueprint statt eines Copy-&-Paste-Einzelprompts. Wer ihn instanziiert, bekommt ein
kleines Gadget mit einem Formular (Kunde + Anfrage) und einem Knopf. Ein Klick spawnt einen
KI-Agenten mit dem festen Angebots-Workflow.

## Bindings

| Binding    | Typ            | Zweck |
| ---------- | -------------- | ----- |
| `WORKFLOW` | agentSpawner   | spawnt den Angebots-Agenten; beim Instanziieren wählt der Nutzer nur das Modell |
| `crm`      | gatekeeper (spawnerOnly) | CRM-Gatekeeper, in die env des Agenten gereicht — Reads direkt, Writes approval-pflichtig |
| `preise`   | gatekeeper (spawnerOnly) | read-only Preiserhebungs-Gatekeeper (Druck + DMS-ROI) |

`crm`/`preise` sind `spawnerOnly`: sie werden **nicht** an das Gadget selbst gebunden, sondern nur
in die Umgebung des gespawnten Agenten. Das Gadget kennt nur `env.WORKFLOW`.

## Ablauf

1. Nutzer trägt Kunde + Anfrage ein und klickt „Angebot erstellen".
2. `Gadget.launch()` ruft `env.WORKFLOW.spawn(titel, prompt)` mit dem kuratierten Workflow-Prompt.
3. Der Agent liest den Deal (CRM), kalkuliert (Preiserhebung) und legt den Entwurf als
   approval-pflichtige CRM-Aktivität an.

Der Workflow-Prompt lebt in `server.js` (`buildPrompt`) — das ist der eigentliche Firmenwert dieses
Blueprints.
