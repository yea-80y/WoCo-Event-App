import { getBee, requirePostageBatch } from "../../config/swarm.js";
import type { Hex64 } from "@woco/shared";

/** Delay helper */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Upload data to Swarm /bytes with retry on 429. */
export async function uploadToBytes(data: string | Uint8Array): Promise<Hex64> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;

  let delay = 500;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await getBee().uploadData(requirePostageBatch(), bytes);
      const ref = typeof result.reference === "string"
        ? result.reference
        : result.reference.toString();
      return ref.toLowerCase().replace(/^0x/, "") as Hex64;
    } catch (err: unknown) {
      const status = (err as any)?.status ?? (err as any)?.response?.status;
      if (status === 429 && attempt < 4) {
        console.log(`[swarm] Upload rate limited, retrying in ${delay}ms...`);
        await wait(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      throw err;
    }
  }

  throw new Error("Upload failed after retries");
}

/** Download data from Swarm /bytes as string, with retry on 429. */
export async function downloadFromBytes(ref: string): Promise<string> {
  let delay = 500;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await getBee().downloadData(ref);

      if (result instanceof Uint8Array) {
        return new TextDecoder().decode(result);
      }

      if (typeof result === "object" && result !== null) {
        const r = result as unknown as Record<string, unknown>;

        if (typeof r["toUtf8"] === "function") return (r["toUtf8"] as () => string)();
        if (typeof r["toText"] === "function") return (r["toText"] as () => string)();
        if (typeof r["text"] === "function") {
          const t = (r["text"] as () => string | Promise<string>)();
          return t instanceof Promise ? await t : t;
        }
        if (r["data"] instanceof Uint8Array) return new TextDecoder().decode(r["data"] as Uint8Array);
        if (r["bytes"] instanceof Uint8Array) return new TextDecoder().decode(r["bytes"] as Uint8Array);

        const payload = r["payload"];
        if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
        if (payload && typeof payload === "object") {
          const p = payload as Record<string, unknown>;
          if (typeof p["toUtf8"] === "function") return (p["toUtf8"] as () => string)();
        }

        throw new Error(`Unexpected downloadData format: ${Object.keys(r).join(", ")}`);
      }

      throw new Error(`Unexpected downloadData type: ${typeof result}`);
    } catch (err: unknown) {
      const status = (err as any)?.status ?? (err as any)?.response?.status;
      if (status === 429 && attempt < 4) {
        console.log(`[swarm] Download rate limited, retrying in ${delay}ms...`);
        await wait(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      throw err;
    }
  }

  throw new Error("Download failed after retries");
}
