/**
 * Gathers what `shareCodes` decides from, without a prompt: the verified
 * profile name, the organiser's page names from their own feeds, and one chain
 * read saying which of those names this account holds and which ones load.
 *
 * `update` fires as each part lands, so Invite to host and Follow me paint at
 * once and page codes join when their reads finish. Chain answers are kept for
 * ten minutes, so a reopened sheet paints the whole set straight away.
 */

import { cacheGet, cacheSet } from "../cache/cache.js";
import { readNameRecords, type NameRecord } from "../sub-ens/name-records.js";
import { verifiedProfileName } from "../sub-ens/profile-name.js";
import { rememberOwner } from "../sub-ens/verify-name.js";
import { readMyPages, type PageName } from "./my-pages.js";
import type { HeldName } from "./share-codes.js";

export interface ShareInputs {
  profileName: string | null;
  held: HeldName[];
  pages: PageName[];
}

const RECORD_TTL_SECONDS = 10 * 60;
const recordKey = (label: string) => `subens-record:${label}`;

export async function loadShareInputs(
  address: string,
  opts: { organiser: boolean; hasSession: boolean },
  update: (inputs: ShareInputs) => void,
): Promise<void> {
  const owner = address.toLowerCase();
  let profileName: string | null = null;
  let pages: PageName[] = [];
  let records: NameRecord[] = [];

  const labels = () => [...new Set([profileName, ...pages.map((p) => p.label)].filter((l): l is string => !!l))];
  const emit = () =>
    update({
      profileName,
      pages,
      held: records.filter((r) => r.owner === owner).map(({ label, points }) => ({ label, points })),
    });
  const paintCached = () => {
    records = labels().flatMap((label) => cacheGet<NameRecord>(recordKey(label)) ?? []);
    emit();
  };

  await Promise.all([
    verifiedProfileName(owner).then((name) => {
      profileName = name?.toLowerCase() ?? null;
      paintCached();
    }),
    opts.organiser
      ? readMyPages(owner, opts.hasSession).then(
          (found) => { pages = found; paintCached(); },
          () => { /* no page codes; Invite to host and Follow me stand */ },
        )
      : undefined,
  ]);

  const fresh = await readNameRecords(labels());
  // An unread chain leaves what the cache painted, so an RPC blip withdraws no code.
  if (!fresh) return;
  for (const record of fresh) {
    cacheSet(recordKey(record.label), record, RECORD_TTL_SECONDS);
    // First-hand chain answer: lets every other name on screen paint without its own check.
    rememberOwner(record.label, record.owner);
  }
  records = fresh;
  emit();
}
