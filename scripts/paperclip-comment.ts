// Posts a comment to a Paperclip issue, and fails loudly when the post did not take.
//
// The reason this is a shared helper and not a `fetch` at the call site: the Paperclip control
// endpoint returns an error body with no `id` field on failure, and a POST there has returned 500
// in production (OWL-1764/OWL-1774). A caller that reads `(await res.json()).id` off that response
// gets `undefined`, not an error -- so a failed post that was never recorded reads as success, and
// an automation (a CI deploy-status comment, say) reports to the board something that never arrived.
//
// Every status outside 2xx throws, and a 2xx whose body carries no `id` throws too. The HTTP status
// is read from `res.ok`/`res.status` directly; success is never inferred from the shape of the body.

/** The subset of the comment response this helper depends on. */
interface IssueCommentResponse {
  id?: unknown;
}

/**
 * Umlaut-Gate (OWL-2180). Board rule (OWL-1757/OWL-1988): write ä/ö/ü/ß out, never ae/oe/ue/ss.
 * The rule lived in the rulebook and was still broken per run, so this is a gate, not another
 * sentence. Each pair maps a transliterated spelling to its correct umlaut spelling.
 *
 * Deliberately a word list, not an `ue`/`ae`/`oe` substring search: the substrings hit correct words
 * (`neue`, `Queue`, `Feature`, `Poesie`) and `Hausausweis` (Haus + Ausweis) is correct too, so it is
 * NOT listed. Add a word only after checking it has no legitimate umlaut-free reading.
 */
const TRANSLITERATIONS: ReadonlyArray<readonly [bad: string, good: string]> = [
  ["fuer", "für"], ["ueber", "über"], ["muessen", "müssen"],
  ["koennen", "können"], ["koennte", "könnte"], ["gruen", "grün"],
  ["zurueck", "zurück"], ["pruefen", "prüfen"], ["pruefung", "Prüfung"],
  ["geprueft", "geprüft"], ["laeuft", "läuft"], ["laenger", "länger"],
  ["oberflaeche", "Oberfläche"], ["schluessel", "Schlüssel"],
  ["naechste", "nächste"], ["waere", "wäre"], ["haette", "hätte"],
  ["moeglich", "möglich"], ["oeffnen", "öffnen"], ["groesse", "Größe"],
  ["heisst", "heißt"], ["weiss", "weiß"], ["gemaess", "gemäß"],
  ["massnahme", "Maßnahme"], ["aendern", "ändern"], ["aenderung", "Änderung"],
  ["erklaerung", "Erklärung"], ["verzoegerung", "Verzögerung"],
  ["ausfuehren", "ausführen"], ["zustaendig", "zuständig"],
  ["unveraendert", "unverändert"], ["loeschen", "löschen"],
  ["erfuellt", "erfüllt"], ["vollstaendig", "vollständig"],
  ["spaeter", "später"], ["frueher", "früher"], ["tatsaechlich", "tatsächlich"],
  ["zusaetzlich", "zusätzlich"], ["urspruenglich", "ursprünglich"],
];

/**
 * Returns the transliterated words found in `body`, each with its correct spelling. Code is masked
 * first -- fenced ``` … ``` and ~~~ … ~~~ blocks and inline `…` spans -- because commands, field
 * names and log output there must not be germanized. Matching is case-insensitive and at word
 * boundaries, so `neue`/`Queue`/`Feature`/`Hausausweis` never trip the gate.
 */
export function findTransliterations(
  body: string,
): Array<{ bad: string; good: string }> {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`]*`/g, " ");
  const found: Array<{ bad: string; good: string }> = [];
  for (const [bad, good] of TRANSLITERATIONS) {
    if (new RegExp(`\\b${bad}\\b`, "i").test(text)) {
      found.push({ bad, good });
    }
  }
  return found;
}

/**
 * Posts `body` as a comment on `issueId` and resolves with the created comment's `id`.
 *
 * `baseUrl` may be given with or without a trailing `/api` (or trailing slash); both are normalized
 * to the same `/api/issues/{id}/comments` endpoint. `runId` is sent as `X-Paperclip-Run-Id`.
 *
 * Rejects when the response status is outside 2xx, or when a 2xx response carries no `id`. The
 * rejection message includes the status and the response text, so a failed post is never silent.
 *
 * Also rejects -- before any network call -- when the body contains a transliterated word
 * (Umlaut-Gate, OWL-2180); the message names the offenders and their correct spelling.
 */
export async function postIssueComment(
  baseUrl: string,
  issueId: string,
  body: string,
  token: string,
  runId: string,
): Promise<string> {
  // Umlaut-Gate (OWL-2180): fail before the POST, never send a germanized body.
  const offenders = findTransliterations(body);
  if (offenders.length > 0) {
    throw new Error(
      "Umlaut-Gate (OWL-2180): comment not posted; write umlauts out instead of ae/oe/ue/ss:\n" +
        offenders.map((o) => `  ${o.bad} -> ${o.good}`).join("\n"),
    );
  }

  const base = baseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  const url = `${base}/api/issues/${issueId}/comments`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Paperclip-Run-Id": runId,
    },
    body: JSON.stringify({ body }),
  });

  // Status first, body second: a non-2xx error body may well be valid JSON with its own shape, and
  // guessing success from the shape is exactly the failure this helper exists to prevent.
  if (!res.ok) {
    const detail = await res.text().catch(() => "<unreadable body>");
    throw new Error(
      `Paperclip comment POST to ${url} failed: HTTP ${res.status} ${res.statusText}\n${detail}`,
    );
  }

  const payload = (await res.json().catch(() => null)) as IssueCommentResponse | null;
  const id = payload?.id;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new Error(
      `Paperclip comment POST to ${url} returned HTTP ${res.status} but no usable \`id\`: ` +
        JSON.stringify(payload),
    );
  }

  return String(id);
}
