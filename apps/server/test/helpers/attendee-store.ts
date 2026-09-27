/**
 * Test helper: put the attendee order store (#546) in its ready state, so a
 * route test exercises what it is about instead of the "no erasable storage"
 * refusal. Call it after `process.chdir` to the test's temp dir and after the
 * routes are imported (the ledger resolves `.data` from cwd at import).
 */

import { randomBytes } from "node:crypto";
import { calculateCacAddress } from "@woco/shared";

export async function readyAttendeeStore(): Promise<{ batchId: string; stamper: string }> {
  process.env.ATTENDEE_STAMPER_PRIVATE_KEY ??= "66".repeat(32);
  const writer = await import("../../src/lib/attendee-batch/writer.js");
  const ledger = await import("../../src/lib/attendee-batch/ledger.js");
  writer._resetAttendeeStamperForTests();
  const stamper = writer.attendeeStamperAddress()!;
  const batchId = randomBytes(32).toString("hex");
  ledger.registerBatch(batchId, 20, stamper, true);
  ledger.setActiveBatch(batchId);
  return { batchId, stamper };
}

/** A fake bee `uploadChunk` that accepts every chunk and answers its true address. */
export async function acceptingUploadChunk(_stamp: unknown, body: Uint8Array): Promise<{ reference: { toHex(): string } }> {
  const address = Buffer.from(calculateCacAddress(body.slice(0, 8), body.slice(8))).toString("hex");
  return { reference: { toHex: () => address } };
}
