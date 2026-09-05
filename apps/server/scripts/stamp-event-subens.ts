/**
 * One-off / ops: stamp a sub-ENS label onto an event feed as a display hint.
 * Verifies on-chain label ownership, then requires the owner to be the event
 * creator (enforced inside stampEventSubEns). Run inside the server container
 * (env from docker) or locally with the bee tunnel up:
 *
 *   node --import tsx apps/server/scripts/stamp-event-subens.ts <eventId> <label>
 */
import { getLabelOwner } from "../src/lib/chain/sub-ens-contract.js";
import { stampEventSubEns } from "../src/lib/event/service.js";

const [eventId, labelArg] = process.argv.slice(2);
if (!eventId || !labelArg) {
  console.error("usage: stamp-event-subens.ts <eventId> <label>");
  process.exit(1);
}
const label = labelArg.toLowerCase().trim();

const owner = await getLabelOwner(label);
if (!owner) {
  console.error(`label "${label}" not found on-chain`);
  process.exit(1);
}

const updated = await stampEventSubEns(eventId, label, owner);
console.log(`stamped ${label}.woco.eth onto "${updated.title}" (${eventId})`);
process.exit(0);
