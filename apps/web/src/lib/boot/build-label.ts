import { parseBuildFeed } from "./build-check";

/**
 * The feed index of the build this page is running, for the footer's tiny version
 * mark: the upload stamps it into `<meta name="woco-feed">`, and a handover to a
 * newer build rewrites that meta before anything mounts (build-swap.ts), so it names
 * the code actually running. null in dev and on any page without the stamp.
 */
export function runningBuildIndex(doc: Pick<Document, "querySelector"> | undefined = globalThis.document): number | null {
  const content = doc?.querySelector('meta[name="woco-feed"]')?.getAttribute("content");
  return parseBuildFeed(content)?.index ?? null;
}
