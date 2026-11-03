/// <reference lib="webworker" />
/**
 * Parses order bundles and checks each box hashes to its root, off the page's thread
 * (#1061). Holds NO keys and imports nothing that does; all logic is in
 * `bundle-verifier.ts`, this file only connects it to the worker's messages.
 */
import { answerVerifyRequest } from "./bundle-verifier.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (e: MessageEvent<unknown>) => {
  const reply = answerVerifyRequest(e.data);
  // Not a request: no reply, and the page's timeout falls back to parsing itself.
  if (reply) scope.postMessage(reply);
};
