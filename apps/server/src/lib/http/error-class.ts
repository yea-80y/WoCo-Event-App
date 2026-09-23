/**
 * The CLASS of a failure, for any response a browser or the public can read.
 *
 * Never put `err.message` on a response: error text is written by libraries
 * that do not know where it will end up. ethers embeds the full request URL,
 * API key included, in a SERVER_ERROR message (verified against ethers 6.x:
 * `info={ "requestUrl": "…/v2/<key>" }`), Etherna echoes its response body,
 * and a fetch of `/stamps/<id>` names the whole batch.
 * So a response gets the class, which is all anyone needs to know where to
 * look, and the raw text goes to the server log.
 *
 * Moved here from `lib/health/probes.ts` (#540) so routes can use it without
 * pulling in the health module's chain and bee configuration.
 */
export function errorClass(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; status?: unknown; cause?: unknown; message?: unknown } | null;
  if (e && typeof e === "object") {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "timed out";
    if (typeof e.message === "string" && e.message.includes("timed out")) return "timed out";
    if (typeof e.status === "number") return `HTTP ${e.status}`;
    const cause = e.cause as { code?: unknown } | undefined;
    if (cause && typeof cause === "object" && typeof cause.code === "string") return `network ${cause.code}`;
    if (typeof e.code === "string") return /^[A-Z_]+$/.test(e.code) ? `rpc ${e.code}` : "unreadable";
  }
  return "unreadable";
}

/** A sentence for a failed request, carrying the class but never the raw text. */
export function failureSentence(what: string, err: unknown): string {
  const cls = errorClass(err);
  return cls === "unreadable" ? `${what}. Please try again.` : `${what} (${cls}). Please try again.`;
}
