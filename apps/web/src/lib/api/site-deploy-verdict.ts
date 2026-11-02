/**
 * The two decisions `deploySite` makes about a browser-built site (#1032 slice 3),
 * kept apart from the request code so they can be tested on their own.
 */

import type { ApiResponse } from "@woco/shared";

const CLIENT_BUILD_FALLBACK = new Set(["COLLECTION_MISMATCH", "RUNTIME_RELEASE_CHANGED", "RUNTIME_RELEASE_UNAVAILABLE"]);

/** The server refused the browser's build in a way the old build path answers. */
export function rebuildOnServer(res: ApiResponse<unknown>): boolean {
  return !res.ok && !!res.code && CLIENT_BUILD_FALLBACK.has(res.code);
}

/** A "client" build stored at any root but the one this browser built: never sign a pointer to it. */
export function storedSomethingElse(
  res: ApiResponse<{ builtBy?: "client" | "server"; contentHash: string }>,
  builtRoot: string | undefined,
): boolean {
  return res.ok && res.data?.builtBy === "client" && res.data.contentHash !== builtRoot;
}
