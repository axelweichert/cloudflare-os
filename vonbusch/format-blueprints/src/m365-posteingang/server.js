// "Microsoft 365 Überblick" — ein read-only Display-Gadget.
//
// Anders als die Workflow-Blueprints (agentSpawner) bindet dieses Gadget den Microsoft-365-
// Gatekeeper DIREKT (nicht spawnerOnly): das Gadget selbst liest über env.m365.* aus dem
// verbundenen Konto und rendert Posteingang, Termine und Aufgaben. Es schreibt nichts (P1).
//
// Runtime-Binding (aus dem Blueprint): env.m365 — die Gatekeeper-Session mit den read-only
// Methoden aus packages/gatekeeper-m365/src/types.d.ts:
//   getProfile(), listMessages({folder?,top?,search?}), getMessage(id),
//   listEvents({top?,startDateTime?,endDateTime?}), getEvent(id),
//   listTaskLists(), listTasks(listId, top?)
//
// Ohne verbundenes Konto / ohne Board-Secrets werfen die Methoden — das Gadget fängt das ab und
// zeigt einen ehrlichen "nicht verbunden"-Hinweis statt Rohfehler.

import { WorkerEntrypoint } from "cloudflare:workers";

function errMsg(e) {
  return String((e && e.message) || e || "Unbekannter Fehler");
}

async function safe(promise, fallback) {
  try {
    return { ok: true, value: await promise };
  } catch (e) {
    return { ok: false, error: errMsg(e), value: fallback };
  }
}

export default class extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/data")) {
      const m365 = this.env.m365;

      // Profil zuerst: schlägt es fehl (kein Konto / Not Configured), ist alles andere sinnlos.
      const profile = await safe(m365.getProfile(), null);
      if (!profile.ok) {
        return Response.json({ connected: false, error: profile.error });
      }

      const [messages, events, taskLists] = await Promise.all([
        safe(m365.listMessages({ folder: "inbox", top: 10 }), []),
        safe(m365.listEvents({ top: 10 }), []),
        safe(m365.listTaskLists(), []),
      ]);

      // Aufgaben aus der Standardliste (oder der ersten Liste), falls vorhanden.
      let tasks = { ok: true, value: [] };
      if (taskLists.ok && taskLists.value.length > 0) {
        const list = taskLists.value.find((l) => l.isDefault) || taskLists.value[0];
        tasks = await safe(m365.listTasks(list.id, 10), []);
      }

      return Response.json({
        connected: true,
        profile: profile.value,
        messages: messages.value,
        messagesError: messages.ok ? null : messages.error,
        events: events.value,
        eventsError: events.ok ? null : events.error,
        tasks: tasks.value,
        tasksError: tasks.ok ? null : tasks.error,
      });
    }

    return new Response(SHELL, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
}

const SHELL = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Microsoft 365 Überblick</title></head>
<body><div id="app"></div><script type="module" src="./client.js"></script></body></html>`;
