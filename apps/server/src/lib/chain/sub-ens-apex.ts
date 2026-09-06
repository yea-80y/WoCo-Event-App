/**
 * The APEX contenthash — the Swarm feed manifest the WoCo app itself lives
 * behind, and what a bound PROFILE name is pointed at so typing it into a
 * browser opens the app at that profile.
 *
 * Env rather than a chain read: the value never moves (a frontend deploy writes
 * a new content hash INTO the feed; the manifest fronting the feed is stable),
 * so reading woco.eth on L1 per bind would buy nothing and would add a mainnet
 * RPC dependency this server does not otherwise have.
 *
 * Unconfigured is NOT an error. Pointing the name at the app is a courtesy on
 * top of the bind, never the bind's truth, so a missing or unusable value must
 * not refuse a bind or stop the process — it is surfaced on /api/health so the
 * silence is visible instead of inferred from a log line nobody reads.
 */

const HEX64 = /^[0-9a-f]{64}$/i;

export interface ApexContenthash {
  /** Lowercased 64-hex Swarm reference, or null when unset or unusable. */
  hash: string | null;
  /** Present only when a value WAS supplied and could not be used. */
  error?: string;
}

/**
 * The whole decision, pure, so it can be exercised without touching the
 * environment or the module cache.
 *
 * A `0x` prefix is REFUSED rather than stripped: the var is documented as the
 * bare reference `updateSubEnsContenthash` takes, and quietly normalising a
 * value that does not match the documented shape hides the one mistake worth
 * catching — a hash pasted from somewhere it is not the same hash.
 */
export function parseApexContenthash(raw: string | undefined): ApexContenthash {
  const value = (raw ?? "").trim();
  if (!value) return { hash: null };
  if (!HEX64.test(value)) {
    return {
      hash: null,
      error: `SUB_ENS_APEX_CONTENTHASH is not a 64-hex Swarm reference (${value.length} chars, no 0x prefix expected)`,
    };
  }
  return { hash: value.toLowerCase() };
}

let cached: ApexContenthash | null = null;

/** Reads the environment ONCE, so the diagnostic is one line and not one per bind. */
function loadApex(): ApexContenthash {
  if (cached) return cached;
  cached = parseApexContenthash(process.env.SUB_ENS_APEX_CONTENTHASH);
  if (cached.error) {
    console.error(`[sub-ens] ${cached.error} — profile names will not be pointed at the app`);
  } else if (!cached.hash) {
    console.log("[sub-ens] SUB_ENS_APEX_CONTENTHASH unset — profile names will not be pointed at the app");
  }
  return cached;
}

/** The apex Swarm reference, or null when the platform has not configured one. */
export function getApexContenthash(): string | null {
  return loadApex().hash;
}

/**
 * /api/health -> subEns. `apexConfigured: false` with an `apexError` is the
 * alarm: someone set the var and it is being ignored.
 */
export function subEnsApexHealth(
  parsed: ApexContenthash = loadApex(),
): { apexConfigured: boolean; apexError?: string } {
  return {
    apexConfigured: parsed.hash !== null,
    ...(parsed.error ? { apexError: parsed.error } : {}),
  };
}
