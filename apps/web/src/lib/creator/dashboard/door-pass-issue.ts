/**
 * Issuing a door pass (live door attendee list): challenge, then the pass with the
 * order-key proof, then - back in the panel - the roster. A server that restarted
 * between the two forgets the challenge and answers "challenge-expired": ask once more,
 * with the same pass id (nothing was issued under it).
 */
import type { DoorMode, DoorPassChallenge, DoorPassIssueRequest } from "@woco/shared";
import { doorPassProof, doorPassRegistration, newDoorPassId } from "../../scanner/door-pass-key.js";

export interface DoorPassApi {
  challenge(eventId: string): Promise<DoorPassChallenge>;
  issue(eventId: string, request: DoorPassIssueRequest): Promise<{ token: string; exp: number; mode: DoorMode }>;
}

const expired = (err: unknown) => (err as { reason?: unknown } | null)?.reason === "challenge-expired";

export async function issueDoorPassWithProof(
  opts: { eventId: string; parent: string; mode: DoorMode; secrets: { current: string } },
  api: DoorPassApi,
): Promise<{ token: string; exp: number; mode: DoorMode }> {
  const { eventId, parent, mode, secrets } = opts;
  const reg = await doorPassRegistration(secrets.current, eventId, newDoorPassId());
  for (let attempt = 0; ; attempt++) {
    const challenge = await api.challenge(eventId);
    const proof = await doorPassProof(secrets, challenge, { eventId, parent, jti: reg.jti, mode, doorKeyRef: reg.doorKeyRef });
    try {
      return await api.issue(eventId, { mode, jti: reg.jti, doorKey: reg.doorKey, challengeId: challenge.challengeId, proof });
    } catch (err) {
      if (attempt === 0 && expired(err)) continue;
      throw err;
    }
  }
}
