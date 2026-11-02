/**
 * Whether a published site has a newer runtime release waiting (#1032). Only a
 * site whose last deploy LINKED a release can fall behind: a full copy (the old
 * server build) carries no version and is updated by the next publish anyway.
 */
export function runtimeUpdateAvailable(rec: { runtimeVersion?: number }, latest: number | null): boolean {
  return latest !== null && typeof rec.runtimeVersion === "number" && rec.runtimeVersion < latest;
}
