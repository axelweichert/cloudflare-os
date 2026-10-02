import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { findTransliterations, postIssueComment } from "./paperclip-comment.ts";

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

  it("rejects a transliterated body before any network call (Umlaut-Gate, OWL-2180)", async () => {
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when the gate fires");
    }) as typeof fetch;
    await assert.rejects(
      postIssueComment("https://board.example", "OWL-1", "Der Lauf laeuft laenger", "tok", "run-1"),
      /Umlaut-Gate[\s\S]*laeuft -> läuft[\s\S]*laenger -> länger/,
    );
  });

  it("posts a body that already uses umlauts", async () => {
    const getRequest = stubFetch(
      new Response(JSON.stringify({ id: "cmt_ok" }), { status: 201 }),
    );
    const id = await postIssueComment(
      "https://board.example",
      "OWL-1",
      "Der Lauf läuft länger",
      "tok",
      "run-1",
    );
    assert.equal(id, "cmt_ok");
    assert.deepEqual(await getRequest().json(), { body: "Der Lauf läuft länger" });
  });
});

/**
 * The Umlaut-Gate (OWL-2180) is a word list, not an `ue`/`ae`/`oe` substring search, and it masks
 * code first. The two failure modes it must avoid are symmetric: missing a real transliteration, and
 * tripping on a correct word (`neue`, `Queue`, `Feature`, `Hausausweis`) or on code. Both are pinned.
 */
describe("findTransliterations", () => {
  it("flags transliterated words with their correct spelling", () => {
    assert.deepEqual(findTransliterations("Der Lauf laeuft laenger"), [
      { bad: "laeuft", good: "läuft" },
      { bad: "laenger", good: "länger" },
    ]);
  });

  it("is case-insensitive and matches at word boundaries", () => {
    assert.equal(findTransliterations("LAEUFT").length, 1);
  });

  it("passes correct umlaut text", () => {
    assert.deepEqual(findTransliterations("Der Lauf läuft länger"), []);
  });

  it("does not trip on correct words that merely contain ue/ae/oe (false-alarm probe)", () => {
    assert.deepEqual(findTransliterations("neue Queue, Feature, Hausausweis"), []);
  });

  it("ignores transliterations inside fenced code blocks", () => {
    const body = "Normaler Text ohne Treffer.\n```\nlaeuft laenger\n```\nEnde.";
    assert.deepEqual(findTransliterations(body), []);
  });

  it("ignores transliterations inside inline code spans", () => {
    assert.deepEqual(findTransliterations("benutze `laeuft` nur inline"), []);
  });
});
