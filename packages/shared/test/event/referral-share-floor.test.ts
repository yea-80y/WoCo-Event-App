// Tripwire for the referral share's 12-month floor (ToS §9, printed on the organiser flyer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { REFERRAL_SHARE_SCHEDULE, referralShareBp } from "../../src/event/types.js";

test("the referral share is one 40% entry: a change needs a per-organiser 12-month floor first", () => {
  assert.deepEqual(
    REFERRAL_SHARE_SCHEDULE.map((t) => t.bp),
    [4000],
    "ToS §9 promises 40% of the fee WoCo keeps on a referred organiser's sales for at least 12 months " +
      "from the first sale that earns a share. The schedule is keyed by sale date alone, so a second " +
      "entry would cut that floor for organisers already referred. Model the floor per organiser " +
      "(their first earning sale + 12 months) in lib/campaign/earnings.ts before changing this.",
  );
  assert.equal(referralShareBp("2027-10-22T23:59:59.000Z"), 4000);
});
