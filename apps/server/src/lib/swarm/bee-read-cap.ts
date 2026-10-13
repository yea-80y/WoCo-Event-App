/**
 * A ceiling on every response bee-js reads, installed once for the process.
 *
 * bee-js 11 sends each request through ITS OWN copy of axios (nested under
 * `@ethersphere/bee-js/node_modules`, pinned to a patched 0.x by the root
 * `overrides`) with `maxContentLength: Infinity`, and its `Bee` options cannot
 * change that. So the cap is a request interceptor on that axios instance: it
 * runs after bee-js merges its config, on every call from every `Bee` — feed
 * reads, `downloadData`, the streaming readers — including any added later.
 * axios then refuses the response and destroys the socket once the body passes
 * the cap, buffered and streamed alike (the streamed half is the 0.31 fix for
 * GHSA-vf2m-468p-8v99, which is why the override must not drop below it).
 *
 * `test/bee-read-cap.test.ts` drives a real `Bee` against a local server and
 * fails if the cap stops reaching bee-js — a bee-js major that drops axios or
 * changes how it imports it will fail there, not in production.
 */
import { createRequire } from "node:module";
import { SWARM_READ_MAX_BYTES } from "../http/read-capped.js";

interface AxiosRequestConfigLike {
  maxContentLength?: number;
}
interface AxiosLike {
  interceptors: {
    request: {
      use(fn: (config: AxiosRequestConfigLike) => AxiosRequestConfigLike): number;
      eject(id: number): void;
    };
  };
}

// Resolve axios FROM bee-js's own location, so this is the instance bee-js
// imports — never the root axios 1.x other dependencies use.
const beeRequire = createRequire(import.meta.resolve("@ethersphere/bee-js"));

let interceptorId: number | null = null;

/** Cap every bee-js response at `maxBytes`. Idempotent; a second call replaces the cap. */
export function capBeeResponses(maxBytes: number = SWARM_READ_MAX_BYTES): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error(`capBeeResponses: bad maxBytes ${maxBytes}`);
  const axios = beeRequire("axios") as AxiosLike;
  if (interceptorId !== null) axios.interceptors.request.eject(interceptorId);
  interceptorId = axios.interceptors.request.use((config) => {
    const current = config.maxContentLength;
    // Keep a tighter cap a caller set; replace bee-js's Infinity (and axios's -1).
    if (!(typeof current === "number" && current > -1 && current <= maxBytes)) {
      config.maxContentLength = maxBytes;
    }
    return config;
  });
}

/** True for the error bee-js surfaces when the cap refused a response. */
export function isBeeResponseTooLarge(err: unknown): boolean {
  return /maxContentLength size of \d+ exceeded/.test(String((err as { message?: unknown })?.message ?? ""));
}
