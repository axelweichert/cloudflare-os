# VON-1798 — Security-Review (Stufe-4-Gate): agentic-inbox `/mcp` via gatekeeper-mcp

**Status:** Gate **NICHT bestanden** für den naiven K1-Andockweg. Andockung erst nach Einziehen des
Mailbox-Pinning-Proxys (unten). PoC der Gegenmaßnahme liegt bei und ist grün.

**Reviewer:** CTO · **Datum:** 2026-08-25 · **Scope:** ob der generische `gatekeeper-mcp` den Zugriff
auf agentic-inbox `/mcp` auf *genau eine* Mailbox verengen kann.

---

## 1. Auftrag (aus VON-1798)

> agentic-inbox hat keine per-mailbox-authz, `/mcp` exponiert alle Mailboxen. Der MCP-Gatekeeper muss
> Zugriff auf genau eine Mailbox verengen.

Der CEO-Stufenplan (VON-1794/1795) führt K1 („agentic-inbox via generischem gatekeeper-mcp") als
Kandidaten mit **geringstem Aufwand**. Dieses Review prüft die Sicherheitsvoraussetzung *vor* der
Andockung.

## 2. Befund (code-belegt)

Der `gatekeeper-mcp` verengt einen Grant ausschließlich über **Tool-Namen**, nie über
**Tool-Argumente**.

- Die Scope-Grammatik kennt nur zwei Verengungen: `#server=…` (Portal-Upstream) und `#tool=a&tool=b`
  (exakte Tool-Namen). Siehe `packages/mcp-shared/src/scope.ts:20-26` (`ToolScope = { serverId?,
  tools? }`) und die Durchsetzung in `scopeAllows()` (`scope.ts:129-134`) — geprüft wird
  ausschließlich `toolName`, die `arguments` eines Calls kommen dort nicht vor.
- `gatekeeper-mcp` **verweigert** `#server=` (das ist Portal-Grammatik) und akzeptiert sonst nur die
  Tool-Namensliste: `packages/gatekeeper-mcp/src/mcp.ts:279-301`.
- Es gibt keinen Ort, an dem ein Argumentwert (z. B. `inbox_id`/`mailbox`) gegen den Grant geprüft
  oder gepinnt wird.

**agentic-inbox-Toolform (extern verifiziert):** AgentMail-artige Server (`mcp.agentmail.to/mcp` u. ä.)
exponieren Tools, die die Inbox als **Argument** tragen (`send_message(inbox_id, …)`,
`list_messages(inbox_id)`) **und** mailbox-übergreifende Tools ohne jede Verengungsmöglichkeit
(„list all inboxes", „list threads in **all** inboxes"). Quelle: AgentMail-MCP-Doku / LobeHub /
mcpservers.org.

## 3. Konsequenz

Named-Tool-Scoping (`#tool=send_message`) lässt die **Mailbox-Auswahl frei**: der Agent setzt
`inbox_id` beliebig. Zusätzlich bleiben `list_all_inboxes`-artige Tools erreichbar, sobald der Grant
sie nennt oder „alle Tools" gewährt wird. Ein Grant auf agentic-inbox `/mcp` über den generischen
`gatekeeper-mcp` verengt damit **de facto auf keine einzige Mailbox** — er exponiert alle.

→ **Der Stufe-4-Gate-Anspruch ist mit `gatekeeper-mcp` allein nicht erfüllbar.** K1 ist ohne
Zusatzbaustein **nicht** der sichere „geringster-Aufwand"-Weg; diese Aufwandseinschätzung im
Stufenplan sollte korrigiert werden (CEO-Info).

## 4. Was `gatekeeper-mcp` bereits korrekt liefert (kein Neubau nötig)

- **Human-in-the-Loop:** Schreib-Tools werden nicht inline ausgeführt, sondern zur Freigabe
  eingereiht; nur `readOnlyHint`-Reads laufen sofort. Trust-Tier `byo` ⇒ Annotationen begründen
  **nie** Auto-Approval, Binding ist owner-only. `packages/gatekeeper-mcp/src/mcp.ts:1-8,76-78`.
- **Audit:** Reads werden als Observations protokolliert, Writes als approval-gated Actions (mit
  Endpoint-genauem Scope-Tag, `mcp.ts:422-424`).

Diese Schicht muss **nicht** nachgebaut werden. Fehlt ausschließlich die **per-mailbox-authz**.

## 5. Gegenmaßnahme (Design) — Mailbox-Pinning-Proxy

Ein dünner MCP-Proxy-Worker sitzt **zwischen** `gatekeeper-mcp` und agentic-inbox `/mcp` und
exponiert selbst ein `/mcp`, das der Gatekeeper als Endpoint verbindet. Er verengt fail-closed auf
genau eine Mailbox:

1. `tools/list`: mailbox-übergreifende / nicht verengbare Tools werden **entfernt**; bei
   mailbox-gebundenen Tools wird das `inbox_id`-Argument aus dem beworbenen Schema **herausgeschnitten**
   (der Agent kann keine Mailbox mehr wählen).
2. `tools/call`: das Mailbox-Argument wird **hart auf die gepinnte Mailbox überschrieben**; ein
   abweichender vom Client gesetzter Wert wird **verweigert** (Angriffsversuch, auditiert); nicht
   freigegebene Tools werden verweigert.

Damit liefert der Proxy die fehlende per-mailbox-authz, der Gatekeeper liefert HITL + Audit —
zusammen ist der Stufe-4-Gate-Anspruch erfüllt. Der Proxy ist protokoll-geformt (JSON-RPC MCP) und
läuft nativ auf workerd.

**Referenz-Endpoint für den Grant:** `https://<proxy-host>/mcp` (eine Mailbox pro Proxy-Instanz/DO).
Der Gatekeeper-Grant kann zusätzlich per `#tool=` auf die erlaubten Tools verengt werden — Defense in
Depth, ersetzt aber **nicht** das Pinning.

## 6. PoC (grün, workerd-frei, kostenfrei)

`vonbusch/mailbox-gatekeeper/` — die Durchsetzungslogik (`pin-mailbox.ts`) plus Test
(`pin-mailbox.test.ts`) gegen einen agentic-inbox-artigen Fake-Upstream mit mehreren Mailboxen.

```
npx tsx --test vonbusch/mailbox-gatekeeper/pin-mailbox.test.ts
# 5 pass: list-Verengung, Auto-Pin, Fremd-Mailbox-Ablehnung, Cross-Mailbox-Tool-Ablehnung, Durchreichung
```

## 7. Empfehlung / nächste Schritte

1. **Andockung stoppen**, bis der Pinning-Proxy als Worker steht (nicht der nackte K1-Weg).
2. Pinning-Logik in einen `WorkerEntrypoint` mit `/mcp`-Transport + Mailbox-DO heben; `gatekeeper-mcp`
   auf `https://<proxy>/mcp` verbinden.
3. End-to-End-Nachweis unter `wrangler dev`: ein Gadget führt über den Gatekeeper eine
   Mailbox-Aktion aus → Approval-Queue (HITL) → Audit; Fremd-Mailbox-Zugriff wird abgelehnt.
4. CEO-Info: K1-Aufwandseinschätzung im Stufenplan korrigieren (Zusatzbaustein nötig).
