# von Busch — Firmen-Workflow-Blueprints (K7)

Teilbare **Blueprints** für wiederkehrende Firmen-Workflows statt Copy-&-Paste-Einzelprompts. Ein
Nicht-Techniker instanziiert einen Blueprint, bekommt ein kleines Gadget mit Formular + Knopf, und
ein Klick spawnt einen KI-Agenten mit dem festen, kuratierten Workflow — angedockt an die von-Busch-
Gatekeeper (CRM, Preiserhebung) aus K2/K6ff.

Umgesetzt als **gebündelte Format-Blueprints** des Cloudflare-OS-Forks (siehe
`packages/workshop-backend/format-blueprints/README.md`), sodass sie auf einem frischen Deployment
schon im `+`-Menü stehen, ohne dass jemand sie erst bauen muss.

## Inhalt

| Blueprint | id | Bindings | Zweck |
| --- | --- | --- | --- |
| Angebot erstellen | `vonbusch.angebot` | `WORKFLOW` (agentSpawner) + `crm`, `preise` (gatekeeper, spawnerOnly) | Kundenanfrage → kalkulierter Angebotsentwurf als CRM-Aktivität |
| Lead qualifizieren | `vonbusch.lead` | `WORKFLOW` (agentSpawner) + `crm` (gatekeeper, spawnerOnly) | Lead nach BANT bewerten, Score + nächster Schritt als CRM-Aktivität |

Der Quellcode jedes Gadgets (inkl. des load-bearing Workflow-Prompts) liegt lesbar unter
`src/<name>/`; das binäre `.gadget`-Archiv wird daraus **deterministisch** gebaut.

## Warum agentSpawner + spawnerOnly-Gatekeeper

Das Gadget selbst kennt nur `env.WORKFLOW` (den agentSpawner). Die Gatekeeper (`crm`, `preise`)
sind als `spawnerOnly` markiert: sie werden **nicht** an das Gadget gebunden, sondern nur in die
Umgebung des gespawnten Agenten gereicht (`BlueprintBinding.env` → `SpawnerEnvTarget`). So kann ein
Nicht-Techniker den Blueprint instanziieren und muss nur ein Modell wählen — die riskanten
Ressourcen-Zugriffe sind vorverdrahtet und laufen über die approval-pflichtigen Gatekeeper.

## Bauen

```
# 1) Archive aus src/ erzeugen (nach jeder Quelländerung):
node vonbusch/format-blueprints/build-blueprints.mjs

# 2) In das Worker-Bundle ziehen — der Fork zeigt FORMAT_BLUEPRINTS_DIR auf DIESES Verzeichnis:
cd packages/workshop-backend && FORMAT_BLUEPRINTS_DIR=../../vonbusch/format-blueprints \
  node scripts/build-format-blueprints.mjs
```

`FORMAT_BLUEPRINTS_DIR` **ersetzt** das Default-Set (docs/sheets/slides) durch dieses. Sollen die
Cloudflare-Defaults erhalten bleiben, deren Paare einmal hierher kopieren und mitpflegen (so
empfiehlt es der Upstream-README, damit das Submodul unangetastet bleibt).

## Prüfen

```
npx tsx --test vonbusch/format-blueprints/blueprints.test.ts
```

Der Test prüft ohne laufende Workshop: Archiv-Format (Magic/Version/Content-Länge), dass der
gzip(Yjs-V2)-Snapshot exakt zu den Quell-Dateien dekodiert, dass `server.js` den agentSpawner
wirklich aufruft, und die Bindings-Stimmigkeit (agentSpawner-`env` verweist nur auf deklarierte,
`spawnerOnly`-Gatekeeper-Bindings) sowie die Sidecar-Regeln.

## Status / offene Gates

- **Code + Build + Test: fertig**, Branch `von-1805-agentspawner-blueprints` (kein main-Merge).
- **Live-Smoke-Test (Board-Gate):** Die Gadget-`server.js`/`client.js` sind am kanonischen
  Gadget-Muster (DurableObject + WorkerEntrypoint) modelliert, aber noch nicht gegen eine laufende
  Cloudflare-OS-Workshop instanziiert. End-to-end (Blueprint im `+`-Menü → Gadget erstellen →
  Modell wählen → Agent spawnt und schreibt approval-pflichtig ins CRM) braucht eine
  deploybare Workshop + die realen Gatekeeper aus K2 (`vonbusch-crm`) und K6ff (`preiserhebung`).
  → CEO-Gate, wie bei den übrigen K-Bausteinen.
