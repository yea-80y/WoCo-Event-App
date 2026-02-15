import { getBee, requirePostageBatch } from "../../config/swarm.js";
import type { Hex64 } from "@woco/shared";

/** Upload data to Swarm /bytes, returns lowercase hex ref. */
export async function uploadToBytes(data: string | Uint8Array): Promise<Hex64> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const result = await getBee().uploadData(requirePostageBatch(), bytes);

  const ref = typeof result.reference === "string"
    ? result.reference
    : result.reference.toString();

  return ref.toLowerCase().replace(/^0x/, "") as Hex64;
}

/** Download data from Swarm /bytes as string. */
export async function downloadFromBytes(ref: string): Promise<string> {
  const result = await getBee().downloadData(ref);

  if (result instanceof Uint8Array) {
    return new TextDecoder().decode(result);
  }

  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;

    // Try common bee-js response methods/properties
    if (typeof r["toUtf8"] === "function") return (r["toUtf8"] as () => string)();
    if (typeof r["toText"] === "function") return (r["toText"] as () => string)();
    if (typeof r["text"] === "function") {
      const t = (r["text"] as () => string | Promise<string>)();
      return t instanceof Promise ? await t : t;
    }
    if (r["data"] instanceof Uint8Array) return new TextDecoder().decode(r["data"] as Uint8Array);
    if (r["bytes"] instanceof Uint8Array) return new TextDecoder().decode(r["bytes"] as Uint8Array);

    // Nested payload
    const payload = r["payload"];
    if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      if (typeof p["toUtf8"] === "function") return (p["toUtf8"] as () => string)();
    }

    throw new Error(`Unexpected downloadData format: ${Object.keys(r).join(", ")}`);
  }

  throw new Error(`Unexpected downloadData type: ${typeof result}`);
}
