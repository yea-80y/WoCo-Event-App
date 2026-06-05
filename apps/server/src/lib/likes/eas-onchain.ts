/**
 * On-chain EAS access for likes — the authoritative layer.
 *
 * DECENTRALISATION POSTURE (feedback_client_first_architecture): the chain is
 * the source of truth. The server's `.data/likes-index.json` is ONLY a fast
 * read cache, and it is provably rebuildable from on-chain logs via
 * `reconcileFromChain()`. The `/record` POST is a non-authoritative *hint* that
 * warms the cache faster than the poller — it is verified on-chain here before
 * anything is written, so a malicious client can't inject a false edge. The end
 * state moves reads to the chain / EAS indexer / Stylus aggregator (#5) and
 * drops this server out of the path; nothing here is allowed to become a trust
 * anchor.
 */

import { JsonRpcProvider, Contract, AbiCoder, id as keccakId, zeroPadValue } from "ethers";
import { EAS_ADDRESS, EAS_CHAIN_ID, EAS_SCHEMA_UID, SubjectType } from "@woco/shared";
import type { Hex0x } from "@woco/shared";
import { getChainRpcUrl } from "../chain/event-contract.js";

const EAS_ABI = [
  "function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))",
];

const ATTESTED_TOPIC = keccakId("Attested(address,address,bytes32,bytes32)");
const REVOKED_TOPIC = keccakId("Revoked(address,address,bytes32,bytes32)");

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

let _provider: JsonRpcProvider | null = null;
function provider(): JsonRpcProvider {
  if (!_provider) _provider = new JsonRpcProvider(getChainRpcUrl(EAS_CHAIN_ID), EAS_CHAIN_ID);
  return _provider;
}

function schemaUid(): Hex0x {
  return (process.env.EAS_SCHEMA_UID as Hex0x | undefined) ?? EAS_SCHEMA_UID;
}

export interface OnChainLike {
  subject: Hex0x;
  subjectType: SubjectType;
  attester: Hex0x;
  uid: Hex0x;
  revoked: boolean;
}

/** Decode the `data` field of our schema: (bytes32 subject, uint8 subjectType). */
function decodeSchemaData(data: string): { subject: Hex0x; subjectType: SubjectType } {
  const [subject, subjectType] = AbiCoder.defaultAbiCoder().decode(["bytes32", "uint8"], data);
  return { subject: (subject as string).toLowerCase() as Hex0x, subjectType: Number(subjectType) };
}

/**
 * Fetch + fully validate an attestation by UID. Returns the canonical on-chain
 * like (or an error string). This is the security linchpin behind `/record`:
 * the attester is read FROM CHAIN, never trusted from the request body.
 */
export async function getVerifiedLike(uid: string): Promise<
  { ok: true; like: OnChainLike } | { ok: false; error: string }
> {
  const eas = new Contract(EAS_ADDRESS, EAS_ABI, provider());
  let att: any;
  try {
    att = await eas.getAttestation(uid);
  } catch {
    return { ok: false, error: "Failed to read attestation on-chain" };
  }
  if (!att || att.attester === ZERO_ADDR) return { ok: false, error: "AttestationNotFound" };
  if ((att.schema as string).toLowerCase() !== schemaUid().toLowerCase()) {
    return { ok: false, error: "SchemaMismatch" };
  }
  let decoded: { subject: Hex0x; subjectType: SubjectType };
  try {
    decoded = decodeSchemaData(att.data as string);
  } catch {
    return { ok: false, error: "MalformedAttestationData" };
  }
  return {
    ok: true,
    like: {
      subject: decoded.subject,
      subjectType: decoded.subjectType,
      attester: (att.attester as string).toLowerCase() as Hex0x,
      uid: (att.uid as string).toLowerCase() as Hex0x,
      revoked: (att.revocationTime as bigint) !== 0n,
    },
  };
}

/**
 * Rebuild the projection straight from EAS logs — the decentralisation
 * backstop. Scans `Attested`/`Revoked` for our schema between fromBlock and
 * head in bounded chunks (public RPCs cap getLogs ranges), resolving each UID's
 * subject/subjectType + current revocation state via getAttestation. Returns
 * the active edge set; the caller folds it into the in-memory store. Not on the
 * hot path — invoke on startup or on demand. Proves the server holds nothing
 * the chain doesn't.
 */
export async function reconcileFromChain(
  fromBlock: number,
  chunkSize = 50_000,
): Promise<{ active: OnChainLike[]; toBlock: number }> {
  const p = provider();
  const head = await p.getBlockNumber();
  const schemaTopic = zeroPadValue(schemaUid(), 32);

  // uid → latest known state (Revoked wins; both events carry uid in data[0:32]).
  const seen = new Map<string, boolean>(); // uid → revoked?
  for (let start = fromBlock; start <= head; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, head);
    const logs = await p.getLogs({
      address: EAS_ADDRESS,
      fromBlock: start,
      toBlock: end,
      // topics: [ Attested|Revoked, recipient?, attester?, schemaUID ]
      topics: [[ATTESTED_TOPIC, REVOKED_TOPIC], null, null, schemaTopic],
    });
    for (const log of logs) {
      const uid = (log.data.slice(0, 66)).toLowerCase(); // first 32 bytes of data
      seen.set(uid, log.topics[0] === REVOKED_TOPIC);
    }
  }

  const active: OnChainLike[] = [];
  for (const [uid, revoked] of seen) {
    if (revoked) continue;
    const res = await getVerifiedLike(uid);
    if (res.ok && !res.like.revoked) active.push(res.like);
  }
  return { active, toBlock: head };
}
