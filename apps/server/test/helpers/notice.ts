/**
 * Test helper: every organiser has a confirmed privacy notice, so a sale-path route
 * test exercises what it is about instead of the notice gate's refusal
 * (`lib/legal/notice-gate.ts`; the gate itself is pinned in privacy-notice-gate.test.ts).
 */

import { ORGANISER_NOTICE_FORMAT, type VersionedFeedRead } from "@woco/shared";
import { __setNoticeGateForTests } from "../../src/lib/legal/notice-gate.js";

export function confirmedNotices(): void {
  __setNoticeGateForTests({
    reader: async (_owner, topic) => {
      const address = topic.slice(topic.lastIndexOf("/") + 1);
      const notice = { format: ORGANISER_NOTICE_FORMAT, address, organiserName: "Organiser", sharing: [], orderRetentionMonths: 6, confirmedAt: "2026-10-11T09:00:00.000Z" };
      return { status: "found", bytes: new TextEncoder().encode(JSON.stringify(notice)), version: 0, scanClean: true } as VersionedFeedRead;
    },
  });
}
