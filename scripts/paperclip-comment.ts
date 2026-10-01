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
 * Posts `body` as a comment on `issueId` and resolves with the created comment's `id`.
 *
 * `baseUrl` may be given with or without a trailing `/api` (or trailing slash); both are normalized
 * to the same `/api/issues/{id}/comments` endpoint. `runId` is sent as `X-Paperclip-Run-Id`.
 *
 * Rejects when the response status is outside 2xx, or when a 2xx response carries no `id`. The
 * rejection message includes the status and the response text, so a failed post is never silent.
 */
export async function postIssueComment(
  baseUrl: string,
  issueId: string,
  body: string,
  token: string,
  runId: string,
): Promise<string> {
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
