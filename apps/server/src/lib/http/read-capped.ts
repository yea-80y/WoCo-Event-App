/**
 * Response-body ceilings — the read-side twin of `body-limit.ts`.
 *
 * Every byte the server reads back from Swarm, Etherna or a federated WoCo API
 * comes through either bee-js (capped in `lib/swarm/bee-read-cap.ts`) or a raw
 * `fetch` whose body is read here. Neither path had a ceiling: bee-js sets
 * axios's `maxContentLength` to Infinity, and `Response.arrayBuffer()` buffers
 * whatever arrives. A ref is chosen by whoever wrote the feed that names it, and
 * a creator-signed feed can name ANY content on the network — a public 2 GB
 * video included — so an unbounded read is a memory-exhaustion lever held by
 * every organiser, and by Etherna and any federated server we read from.
 */
import {
  SOC_IDENTIFIER_SIZE,
  SOC_MAX_PAYLOAD_SIZE,
  SOC_SIGNATURE_SIZE,
  SOC_SPAN_SIZE,
} from "@woco/shared";
import { API_MAX_BODY_BYTES } from "./body-limit.js";

/**
 * The most the server reads for one blob. Equal to the API's request-body
 * ceiling because every blob we read back was written through a route bounded
 * by it, or by the server itself — and `uploadToBytes` refuses to write past it,
 * so the server can never store what it would then refuse to read.
 */
export const SWARM_READ_MAX_BYTES = API_MAX_BODY_BYTES;

/** The largest single chunk on the wire: a stored SOC (id + sig + span + payload).
 *  A CAC (span + payload) is smaller, so this bounds both. */
export const SWARM_CHUNK_MAX_BYTES =
  SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE + SOC_SPAN_SIZE + SOC_MAX_PAYLOAD_SIZE;

/** A control-plane JSON answer from Bee, Etherna or its SSO (`{ reference }`, a
 *  token, a stamp). Kilobytes when honest; this only stops a hostile one. */
export const CONTROL_JSON_MAX_BYTES = 1024 * 1024;

/** How much of an error body is read to quote in an error message. */
const ERROR_SNIPPET_MAX_BYTES = 4096;

/**
 * A body over its ceiling. `status: 413` keeps it out of every retry classifier
 * (`isTransientSwarmError` retries 429/423/5xx only): the same ref answers the
 * same size every time, so a retry would only pay for the bytes again.
 */
export class ResponseTooLargeError extends Error {
  readonly status = 413;
  readonly code = "RESPONSE_TOO_LARGE";
  constructor(readonly maxBytes: number, label: string) {
    super(`${label}: response exceeds ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * Read a fetch body, refusing past `maxBytes`. A declared Content-Length over the
 * cap is refused before any body byte is read; an undeclared or lying one is
 * counted as it streams and the stream is cancelled the moment it passes the cap,
 * so at most `maxBytes` plus one network read is ever held.
 */
export async function readCapped(resp: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await resp.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes, label);
  }
  const { bytes, truncated } = await readUpTo(resp, maxBytes);
  if (truncated) throw new ResponseTooLargeError(maxBytes, label);
  return bytes;
}

/**
 * The first `maxBytes` of a body, the rest never read (the stream is cancelled).
 * For callers that want a prefix by design — an HTML page scanned for metadata —
 * where an oversized body is not an error.
 */
export async function readPrefix(resp: Response, maxBytes: number): Promise<Uint8Array> {
  return (await readUpTo(resp, maxBytes)).bytes;
}

/**
 * Up to `maxChars` of an error body for a message, never throwing: the error
 * being built is the one that matters. Reads at most a few KB, so a hostile
 * gateway cannot make building an error message the expensive part.
 */
export async function errorSnippet(resp: Response, maxChars = 300): Promise<string> {
  try {
    const { bytes } = await readUpTo(resp, ERROR_SNIPPET_MAX_BYTES);
    return new TextDecoder().decode(bytes).slice(0, maxChars);
  } catch {
    return "";
  }
}

async function readUpTo(resp: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!resp.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = resp.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      parts.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    parts.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.byteLength;
  }
  return { bytes, truncated };
}

export async function readCappedText(resp: Response, maxBytes: number, label: string): Promise<string> {
  return new TextDecoder().decode(await readCapped(resp, maxBytes, label));
}

export async function readCappedJson<T>(resp: Response, maxBytes: number, label: string): Promise<T> {
  return JSON.parse(await readCappedText(resp, maxBytes, label)) as T;
}
