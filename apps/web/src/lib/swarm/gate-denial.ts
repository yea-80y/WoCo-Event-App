/**
 * Whether a 403 came from OUR chunk gate.
 *
 * ITS OWN MODULE ON PURPOSE. `client-soc.ts` reaches the Svelte auth store
 * through `../api/client.js`, so importing it from a `node:test` file throws
 * `$state is not defined` — and the alternative, testing the trust rule through
 * a mock, would be testing the mock. This is the single decision that turns a
 * refusal into "the chunk does not exist", so it is kept where it can be
 * exercised directly.
 */

/**
 * The rule itself, as opposed to anything else that can produce a 403
 * (Cloudflare, a WAF, a corporate proxy, an ISP interstitial).
 *
 * This distinction is the entire safety argument for treating a 403 as
 * `absent`. The gate is authoritative about what exists behind it: it refuses
 * precisely the addresses it has never been told about, and every write
 * whitelists its own address before uploading. An untagged 403 is somebody
 * upstream saying no, which is "couldn't ask" — and #138/#156 exist because a
 * "couldn't ask" once got cached as an answer.
 *
 * Checked in two places because libraries disagree about what they surface.
 * The header is the clean signal (the proxy CORS-exposes `X-Chunk-Gate`), but
 * bee-js surfaces an error body more reliably than headers, so the body's
 * machine-readable `code` is the fallback. Prose is never matched — only the
 * code — so rewording the message cannot silently change trust behaviour.
 */
/** The machine-readable code the proxy puts in a whitelist denial body. Matched
 *  exactly — never the human message, so rewording prose cannot change trust. */
export const GATE_DENIAL_CODE = "NOT_WHITELISTED";

/** Decode whatever an HTTP library handed us as a body into text. Binary is the
 *  case that matters: bee-js gives an ArrayBuffer. */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(v));
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return ""; }
  }
  return String(v);
}

export function isOurGateDenial(err: unknown): boolean {
  const e = err as {
    responseBody?: unknown;
    response?: { data?: unknown; headers?: unknown };
    message?: string;
  };

  const headers = e?.response?.headers as
    | { get?: (k: string) => unknown }
    | Record<string, unknown>
    | undefined;
  const rawHeader =
    typeof (headers as { get?: (k: string) => unknown })?.get === "function"
      ? (headers as { get: (k: string) => unknown }).get("x-chunk-gate")
      : (headers as Record<string, unknown> | undefined)?.["x-chunk-gate"];
  if (typeof rawHeader === "string" && rawHeader.toLowerCase() === "not-whitelisted") return true;

  // bee-js (v11) throws `BeeResponseError`, which carries NO `response` object
  // and NO headers — only `status`, `message`, and `responseBody` as an
  // **ArrayBuffer**. Verified against the live error in a browser, 2026-08-20.
  // An earlier version of this function fed that ArrayBuffer to JSON.stringify,
  // which yields "{}", so the marker was never found and the whole
  // trust-the-tag path silently never fired. It typechecked and its tests
  // passed, because the tests used strings.
  for (const candidate of [e?.responseBody, e?.response?.data, e?.message]) {
    if (candidate === undefined || candidate === null) continue;
    const text = asText(candidate);
    if (text && text.includes(GATE_DENIAL_CODE)) return true;
  }
  return false;
}

