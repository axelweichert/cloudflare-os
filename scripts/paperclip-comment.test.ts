import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { postIssueComment } from "./paperclip-comment.ts";

/**
 * The invariant this file locks down is not "the helper returns the id" -- it is that a post which
 * did not take can never read as one that did. That is the bug from OWL-1764/OWL-1774: a 500 whose
 * body has no `id` turns into `undefined`, and `undefined` is reported to the board as done.
 *
 * Neither direction is enforceable by types or by review alone: `fetch` resolves on a 500 just as it
 * does on a 201, and nothing in the types distinguishes an error body from a success body. So each
 * failure mode -- non-2xx status, and a 2xx with no id -- is pinned by a test that asserts the helper
 * throws, next to the one success case that asserts it resolves.
 */
describe("postIssueComment", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Records the single request the helper makes, so the headers/URL contract is checked too.
  function stubFetch(response: Response): () => Request {
    let captured: Request | undefined;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      captured = new Request(...args);
      return response;
    }) as typeof fetch;
    return () => {
      assert.ok(captured, "expected fetch to be called");
      return captured;
    };
  }

  it("throws on a non-2xx status even when the error body is valid JSON", async () => {
    stubFetch(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    await assert.rejects(
      postIssueComment("https://board.example", "OWL-1", "hi", "tok", "run-1"),
      /HTTP 500/,
    );
  });

  it("throws on a 2xx response that carries no id", async () => {
    stubFetch(new Response(JSON.stringify({ ok: true }), { status: 201 }));
    await assert.rejects(
      postIssueComment("https://board.example", "OWL-1", "hi", "tok", "run-1"),
      /no usable `id`/,
    );
  });

  it("resolves with the id on a 2xx response that carries one", async () => {
    const getRequest = stubFetch(
      new Response(JSON.stringify({ id: "cmt_123" }), { status: 201 }),
    );
    const id = await postIssueComment(
      "https://board.example/api/",
      "OWL-1",
      "hello",
      "tok",
      "run-1",
    );
    assert.equal(id, "cmt_123");

    const req = getRequest();
    assert.equal(req.method, "POST");
    assert.equal(req.url, "https://board.example/api/issues/OWL-1/comments");
    assert.equal(req.headers.get("authorization"), "Bearer tok");
    assert.equal(req.headers.get("content-type"), "application/json");
    assert.equal(req.headers.get("x-paperclip-run-id"), "run-1");
    assert.deepEqual(await req.json(), { body: "hello" });
  });
});
