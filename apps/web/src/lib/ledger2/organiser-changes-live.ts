/** Live wiring for `organiser-changes.ts`: viem reads on the Kernel chain, the organiser key, the relay. */

import type { Ledger2Action, Ledger2RelayRequest, Ledger2RelayResult, Ledger2Target } from "@woco/shared/ticket/ledger2-terms";
import type { Ledger2ClientIO, SeriesRead } from "./organiser-changes.js";

const READ_ABI = [
  "function getEvent(bytes32 eventId) view returns (uint64 totalSupply, uint64 nextSlot, address organiser, bytes32 manifestRef)",
  "function getEventStatus(bytes32 eventId) view returns (uint64 eventEndTs, bool cancelled)",
  "function getOrganiserKey(bytes32 eventId) view returns (address)",
  "function getRegisteredSupply(bytes32 eventId) view returns (uint64)",
  "function termsNonces(bytes32 eventId) view returns (uint256)",
  "function isSeated(bytes32 eventId) view returns (bool)",
  "function setSupplyDigest(bytes32 eventId, uint64 supply, uint256 issuedAt, uint256 deadline) view returns (bytes32)",
  "function extendSalesEndDigest(bytes32 eventId, uint64 eventEndTs, uint256 issuedAt, uint256 deadline) view returns (bytes32)",
  "function cancelEventDigest(bytes32 eventId, uint256 issuedAt, uint256 deadline) view returns (bytes32)",
  "function revokeSignaturesDigest(bytes32 eventId, uint256 issuedAt, uint256 deadline) view returns (bytes32)",
  "error EventNotFound()",
] as const;

async function client() {
  const [{ createPublicClient, http, fallback, parseAbi }, { ownerScanRpcUrls }, { KERNEL_CHAIN }] = await Promise.all([
    import("viem"),
    import("../auth/owned-accounts-scan.js"),
    import("../auth/kernel-account.js"),
  ]);
  const transports = ownerScanRpcUrls().map((url) => http(url, { timeout: 20_000 }));
  return {
    pc: createPublicClient({ chain: KERNEL_CHAIN, transport: transports.length === 1 ? transports[0]! : fallback(transports) }),
    abi: parseAbi(READ_ABI),
  };
}

type Hex = `0x${string}`;

export const liveLedger2ClientIO: Ledger2ClientIO = {
  async deployment(): Promise<Ledger2Target | null> {
    const [{ ownLedger2Deployment }, { KERNEL_CHAIN_ID }] = await Promise.all([
      import("../keyring/organiser-event-scan.js"),
      import("@woco/shared/kernel/chain"),
    ]);
    const d = await ownLedger2Deployment();
    return d ? { chainId: KERNEL_CHAIN_ID, address: d.address.toLowerCase() } : null;
  },

  async readSeries(ledger, ids) {
    if (ids.length === 0) return [];
    const [{ pc, abi }, { BaseError }] = await Promise.all([client(), import("viem")]);
    const address = ledger as Hex;
    const fns = ["getEvent", "getEventStatus", "getOrganiserKey", "getRegisteredSupply", "termsNonces", "isSeated"] as const;
    const res = await pc.multicall({
      contracts: ids.flatMap((id) => fns.map((functionName) => ({ address, abi, functionName, args: [id as Hex] }))),
      allowFailure: true,
    });
    const notFound = (e: unknown) =>
      e instanceof BaseError && !!e.walk((x) => (x as { data?: { errorName?: string } }).data?.errorName === "EventNotFound");
    const n = fns.length;
    return ids.map((_, i): SeriesRead | null => {
      const [ev, status, key, registered, nonce, seated] = res.slice(i * n, i * n + n);
      if (ev!.status === "failure" && notFound(ev!.error)) return null;
      for (const r of [ev, status, key, registered, nonce, seated]) {
        if (r!.status !== "success") throw new Error("Couldn't read your event's tickets just now.");
      }
      const [totalSupply, nextSlot, organiser] = ev!.result as readonly [bigint, bigint, string, string];
      const [eventEndTs, cancelled] = status!.result as readonly [bigint, boolean];
      return {
        organiser: organiser.toLowerCase(),
        organiserKey: (key!.result as string).toLowerCase(),
        totalSupply: Number(totalSupply),
        nextSlot: Number(nextSlot),
        registeredSupply: Number(registered!.result as bigint),
        eventEndTs: Number(eventEndTs),
        cancelled,
        termsNonce: nonce!.result as bigint,
        seated: seated!.result === true,
      };
    });
  },

  async chainNow() {
    const { pc } = await client();
    const b = await pc.getBlock({ blockTag: "latest" });
    return Number(b.timestamp);
  },

  async chainDigest(ledger: string, a: Ledger2Action) {
    const { pc, abi } = await client();
    const address = ledger as Hex;
    const id = a.eventId as Hex;
    const w = [BigInt(a.issuedAt), BigInt(a.deadline)] as const;
    switch (a.kind) {
      case "setSupply":
        return pc.readContract({ address, abi, functionName: "setSupplyDigest", args: [id, BigInt(a.supply), ...w] });
      case "extendSalesEnd":
        return pc.readContract({ address, abi, functionName: "extendSalesEndDigest", args: [id, BigInt(a.eventEndTs), ...w] });
      case "cancel":
        return pc.readContract({ address, abi, functionName: "cancelEventDigest", args: [id, ...w] });
      case "revoke":
        return pc.readContract({ address, abi, functionName: "revokeSignaturesDigest", args: [id, ...w] });
      default:
        throw new Error("seat moves are signed by the seating editor");
    }
  },

  async organiserKey() {
    const { auth } = await import("../auth/auth-store.svelte.js");
    await auth.ensureOrganiserUnlock();
    const secrets = await auth.getAccountSecrets({ toSeal: true });
    if (!secrets) throw new Error("This device can't confirm changes to your events right now - sign in again and retry.");
    const { deriveOrganiserKey } = await import("@woco/shared/crypto/organiser-key");
    return deriveOrganiserKey(secrets.current);
  },

  async relay(eventId: string, request: Ledger2RelayRequest): Promise<Ledger2RelayResult> {
    const [{ authPost }, { apiError }] = await Promise.all([import("../api/client.js"), import("../api/errors.js")]);
    let resp;
    try {
      resp = await authPost<Ledger2RelayResult>(`/api/events/${encodeURIComponent(eventId)}/ledger2/relay`, request as unknown as Record<string, unknown>);
    } catch {
      throw Object.assign(new Error("network"), { code: "network" });
    }
    if (!resp.ok || !resp.data) throw apiError(resp, "Couldn't save the change");
    return resp.data;
  },

  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
