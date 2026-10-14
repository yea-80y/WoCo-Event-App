/**
 * The buyer's marketing choice on its way from create-checkout to fulfilment,
 * through the Checkout Session's tagged metadata (#645 commits to every key).
 *
 * Carried, not decided at session creation: a record for a sale that never
 * completes is worthless, so only fulfilment writes one. What travels is what
 * the page showed (mode + wording version + surface) and what the buyer did
 * with the box - never wording, which the server looks up itself
 * (`marketingWording`). No keys at all = no control was shown = nothing is
 * recorded, in either mode.
 */

import { parseMarketingChoice, type MarketingChoice } from "@woco/shared";

/** The metadata keys for a choice. The own-events sentence names the organiser, so their name travels too. */
export function marketingMetadata(choice: MarketingChoice | undefined, organiserName: string): Record<string, string> {
  if (!choice) return {};
  return {
    marketingMode: choice.mode,
    marketingTicked: choice.ticked ? "1" : "0",
    marketingVersion: String(choice.version),
    marketingSurface: choice.surface,
    ...(choice.mode === "own-events" && organiserName ? { marketingOrganiser: organiserName } : {}),
  };
}

/** The choice a paid session carries; undefined when it carries none, or one that does not parse. */
export function marketingFromMetadata(
  md: Record<string, string> | null | undefined,
): { choice: MarketingChoice; organiserName?: string } | undefined {
  if (!md?.marketingMode) return undefined;
  const ticked = md.marketingTicked === "1" ? true : md.marketingTicked === "0" ? false : undefined;
  const choice = parseMarketingChoice({
    mode: md.marketingMode,
    ticked,
    version: Number(md.marketingVersion),
    surface: md.marketingSurface,
  });
  if (!choice) return undefined;
  return { choice, ...(md.marketingOrganiser ? { organiserName: md.marketingOrganiser } : {}) };
}
