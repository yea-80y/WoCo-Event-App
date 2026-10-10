/**
 * #540: responses carry the CLASS of a failure, never its text. Library error
 * text can hold secrets - ethers puts the keyed RPC URL in SERVER_ERROR.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { errorClass, failureSentence } from "../src/lib/http/error-class.js";

const SECRET = "SECRETKEY123";
const withSecret = <T extends object>(extra: T) =>
  Object.assign(new Error(`upstream failed, requestUrl https://rpc.example/v2/${SECRET}`), extra);

test("each failure shape maps to its class", () => {
  assert.equal(errorClass(Object.assign(new Error("x"), { name: "TimeoutError" })), "timed out");
  assert.equal(errorClass(Object.assign(new Error("x"), { name: "AbortError" })), "timed out");
  assert.equal(errorClass(new Error("request timed out after 30s")), "timed out");
  assert.equal(errorClass(withSecret({ status: 503 })), "HTTP 503");
  assert.equal(errorClass(withSecret({ cause: { code: "ECONNRESET" } })), "network ECONNRESET");
  assert.equal(errorClass(withSecret({ code: "SERVER_ERROR" })), "rpc SERVER_ERROR");
  assert.equal(errorClass(withSecret({ code: "lower-case" })), "unreadable");
  assert.equal(errorClass(withSecret({})), "unreadable");
  assert.equal(errorClass("a string"), "unreadable");
  assert.equal(errorClass(null), "unreadable");
});

test("no class or sentence ever contains the error's own text", () => {
  const shapes = [{ status: 500 }, { cause: { code: "ENOTFOUND" } }, { code: "CALL_EXCEPTION" }, {}];
  for (const extra of shapes) {
    const err = withSecret(extra);
    assert.ok(!errorClass(err).includes(SECRET));
    assert.ok(!failureSentence("Registration failed", err).includes(SECRET));
  }
});

test("the sentence names the class, or just asks for a retry when there is none", () => {
  assert.equal(
    failureSentence("Could not create this badge", withSecret({ code: "SERVER_ERROR" })),
    "Could not create this badge (rpc SERVER_ERROR). Please try again.",
  );
  assert.equal(failureSentence("Could not create this badge", new Error("anything")), "Could not create this badge. Please try again.");
});

/**
 * Ratchet: the responses on a chain-touching path must not carry error text.
 * These files reach a browser (one of them without authentication) and read the
 * chain through the keyed RPC URL, which ethers prints in its error messages.
 */
test("no chain-path response embeds the error's own message (#540)", () => {
  const files = [
    "../src/lib/object/gate-check.ts",
    "../src/routes/objects.ts",
  ];
  const offender = /error:\s*[^\n]*\berr(or)?\b[^\n]*\.message/;
  for (const rel of files) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf-8");
    for (const [i, line] of src.split("\n").entries()) {
      assert.ok(
        !offender.test(line),
        `${rel}:${i + 1} puts the error's text in a response - use failureSentence()/errorClass(): ${line.trim()}`,
      );
    }
  }
});
