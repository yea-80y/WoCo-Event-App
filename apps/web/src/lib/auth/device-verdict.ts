/**
 * Ask the server what an ADDED passkey is to an account (#746 step 3), before the
 * sign-in commits anything.
 *
 * The grant list lives with the server and is re-checked on every request, so the
 * one authoritative answer to "is this passkey still a device of the account?" is
 * whether the server accepts a session it signed. A grant held on the device could
 * not see a removal, and a passkey in a synced password manager signs in on
 * devices that never held one.
 *
 * Signs one `POST /api/auth/whoami` from in-memory material - nothing is stored -
 * and maps the answer:
 *   device       accepted as a granted device
 *   owner        this passkey owns the account now (it was made the main one)
 *   removed      its grant was revoked
 *   invalid      neither granted nor owner
 *   unreachable  no verdict (network, server, a wrong device clock) - not a refusal
 */

import { AuthErrorCode, type SessionDelegation } from "@woco/shared";
import { requestChallenge, sha256Hex } from "./request-challenge.js";

export type DeviceVerdict = "device" | "owner" | "removed" | "invalid" | "unreachable";

const WHOAMI_PATH = "/api/auth/whoami";

export async function deviceVerdict(args: {
  delegation: SessionDelegation;
  sessionPrivateKey: string;
  base: string;
  fetchFn?: typeof fetch;
}): Promise<DeviceVerdict> {
  const fetchFn = args.fetchFn ?? fetch;
  try {
    const { Wallet } = await import("ethers");
    const session = new Wallet(args.sessionPrivateKey);
    const body = "";
    const nonce = crypto.randomUUID();
    const timestamp = Date.now().toString();
    const signature = await session.signMessage(
      requestChallenge("POST", WHOAMI_PATH, timestamp, nonce, await sha256Hex(body)),
    );
    const delegationJson = JSON.stringify(args.delegation);
    const res = await fetchFn(`${args.base}${WHOAMI_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Address": session.address,
        "X-Session-Delegation": btoa(unescape(encodeURIComponent(delegationJson))),
        "X-Session-Sig": signature,
        "X-Session-Nonce": nonce,
        "X-Session-Timestamp": timestamp,
      },
      body,
    });
    const json = (await res.json().catch(() => null)) as
      | { data?: { sessionRank?: unknown }; code?: unknown }
      | null;
    if (res.ok) {
      const rank = json?.data?.sessionRank;
      return rank === "device" ? "device" : rank === "owner" ? "owner" : "unreachable";
    }
    if (res.status === 401 || res.status === 403) {
      if (json?.code === AuthErrorCode.DEVICE_REMOVED) return "removed";
      if (json?.code === AuthErrorCode.SESSION_CLOCK_SKEW) return "unreachable";
      return "invalid";
    }
    return "unreachable";
  } catch {
    return "unreachable";
  }
}
