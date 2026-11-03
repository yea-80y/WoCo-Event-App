/**
 * The two decisions `deploySite` makes about a browser-built site (#1032),
 * kept apart from the request code so they can be tested on their own.
 */

import type { ApiResponse } from "@woco/shared";

/**
 * The server holds a newer runtime release than the kit this build used: build
 * once more on the new one. Every other refusal stands - there is no server
 * build to fall back to since slice 4.
 */
export function rebuildForNewRuntime(res: ApiResponse<unknown>): boolean {
  return !res.ok && res.code === "RUNTIME_RELEASE_CHANGED";
}

/** A "client" build stored at any root but the one this browser built: never sign a pointer to it. */
export function storedSomethingElse(
  res: ApiResponse<{ builtBy?: "client" | "server"; contentHash: string }>,
  builtRoot: string | undefined,
): boolean {
  return res.ok && res.data?.builtBy === "client" && res.data.contentHash !== builtRoot;
}
