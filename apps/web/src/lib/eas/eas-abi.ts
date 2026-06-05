/**
 * Minimal EAS ABI fragments for the likes write path. Kept import-free so both
 * the Kernel call-policy widening (auth/kernel-account.ts) and the attest code
 * (eas/attest.ts) can pull from it without a circular module dependency.
 *
 * Function shapes mirror IEAS on Arbitrum Sepolia — `attest(AttestationRequest)`
 * and `revoke(RevocationRequest)`. Both are scoped by selector in the session
 * key's call policy.
 */

export const EAS_SESSION_ABI = [
  {
    type: "function",
    name: "attest",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "revoke",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "uid", type: "bytes32" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/**
 * `Attested` / `Revoked` events. The single non-indexed field `uid` is what we
 * read back from a confirmed attest receipt (the on-chain UID needed to later
 * `revoke`). schemaUID is indexed so we can filter logs to our schema.
 */
export const EAS_EVENTS_ABI = [
  {
    type: "event",
    name: "Attested",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "attester", type: "address", indexed: true },
      { name: "uid", type: "bytes32", indexed: false },
      { name: "schemaUID", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Revoked",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "attester", type: "address", indexed: true },
      { name: "uid", type: "bytes32", indexed: false },
      { name: "schemaUID", type: "bytes32", indexed: true },
    ],
  },
] as const;
