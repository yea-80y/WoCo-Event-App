/** 64-char hex string without 0x prefix (Swarm references) */
export type Hex64 = string;

/** Hex string with 0x prefix (Ethereum addresses, hashes) */
export type Hex0x = `0x${string}`;

/** Standard API response envelope */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Machine-readable error code (e.g. BATCH_PURCHASE_REQUIRED) — UI branches on
   *  this, never on the human-readable `error` text. */
  code?: string;
}
