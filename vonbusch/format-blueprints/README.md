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
# Archive aus src/ erzeugen (nur nach einer Quelländerung nötig):
node vonbusch/format-blueprints/build-blueprints.mjs
```

Das Einziehen ins Worker-Bundle ist **fest verdrahtet** (VON-1819, siehe „OS-Integration" unten):
`packages/workshop-backend` `build:worker` (und die `test:*`-Skripte) rufen den Upstream-Generator
`scripts/build-format-blueprints.mjs` bereits mit `FORMAT_BLUEPRINTS_DIR=../../vonbusch/format-blueprints`
auf. Ein `wrangler deploy` regeneriert damit `src/generated/format-blueprints.ts` aus DIESEM
Verzeichnis — kein manueller Zweitschritt mehr.

`FORMAT_BLUEPRINTS_DIR` **ersetzt** das Default-Set (docs/sheets/slides) durch dieses. Damit die
Cloudflare-Defaults erhalten bleiben, liegen ihre Paare (`workspace-docs`, `workspace-sheets`,
`workspace-slides`) **mit hier** — dieses Verzeichnis ist das *vollständige* Format-Set des
Deployments (2 von-Busch-Blueprints + 3 Cloudflare-Defaults = 5). Ein Rebuild bundelt alle fünf.

## OS-Integration (VON-1819)

K7 ist die **Sonderform** unter den Port-Kind-Issues: die Firmen-Blueprints sind **kein**
klassischer `GatekeeperVendor`/`Gatekeeper<Session>`-Ressourcen-Gadget und brauchen daher **kein
eigenes `packages/gatekeeper-vonbusch-*`-Package und keinen zweiten Worker/Service**. Sie werden über
die native OS-Format-Blueprint-Fläche (`FORMAT_BLUEPRINTS_DIR` → generiertes, ins Backend-Bundle
gebackenes `src/generated/format-blueprints.ts`) integriert. Die Integration ist damit **reine
Backend-Build-Konfig** am bestehenden `cloudflareos-backend` — beantwortet die im Issue gestellte
Frage „eigenes Package oder reine Backend-Konfig?" mit **Backend-Konfig**.

Was der Port konkret geändert hat:

1. `packages/workshop-backend` `build:worker` regeneriert das Bundle jetzt aus diesem Verzeichnis
   (vorher lief der Generator nur in `test:*` und **nie** im Deploy-Pfad — ein `wrangler deploy`
   hätte ein veraltetes/defaults-freies Artefakt verwendet).
2. Die drei Cloudflare-Default-Blueprints wurden hierher kopiert, sodass das Zeigen von
   `FORMAT_BLUEPRINTS_DIR` auf dieses Verzeichnis sie nicht mehr fallen lässt.
3. Die `test:*`-Skripte zeigen ebenfalls hierher, damit sie das Bundle nicht auf „nur Defaults"
   zurücksetzen.

Die einzige echte Laufzeit-Abhängigkeit der Blueprints sind die `spawnerOnly`-Gatekeeper `crm` und
`preise` (aus K2 `gatekeeper-vonbusch-crm` / K4 `preiserhebung`): deren Service-Bindings müssen am
Backend anliegen, damit ein gespawnter Agent ins CRM/Preise schreiben kann. Das ist der Deploy-Gate
der jeweiligen Port-Issues (VON-1817/1816/…), nicht von K7 selbst.

## Prüfen

```
npx tsx --test vonbusch/format-blueprints/blueprints.test.ts
```

Der Test prüft ohne laufende Workshop: Archiv-Format (Magic/Version/Content-Länge), dass der
gzip(Yjs-V2)-Snapshot exakt zu den Quell-Dateien dekodiert, dass `server.js` den agentSpawner
wirklich aufruft, und die Bindings-Stimmigkeit (agentSpawner-`env` verweist nur auf deklarierte,
`spawnerOnly`-Gatekeeper-Bindings) sowie die Sidecar-Regeln.

## Status / offene Gates

- **Code + Build + Test: fertig** (Branch `von-1805-agentspawner-blueprints`, in `main` gemerged VON-1813).
- **OS-Integration verdrahtet: fertig** (VON-1819, Branch `von-1819-blueprints-port`): Deploy-Pfad
  regeneriert das Bundle aus diesem Verzeichnis; alle 5 Blueprints landen im generierten Modul; K7-Test grün.
- **Live-Smoke-Test (Board-Gate):** Die Gadget-`server.js`/`client.js` sind am kanonischen
  Gadget-Muster (DurableObject + WorkerEntrypoint) modelliert, aber noch nicht gegen eine laufende
  Cloudflare-OS-Workshop instanziiert. End-to-end (Blueprint im `+`-Menü → Gadget erstellen →
  Modell wählen → Agent spawnt und schreibt approval-pflichtig ins CRM) braucht eine
  deploybare Workshop + die realen Gatekeeper aus K2 (`vonbusch-crm`) und K6ff (`preiserhebung`).
  → CEO-Gate, wie bei den übrigen K-Bausteinen.
