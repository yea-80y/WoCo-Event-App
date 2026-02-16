/**
 * ECIES sealed box — the output of encrypting data to a recipient's X25519 public key.
 * Uses ephemeral ECDH + HKDF-SHA256 + AES-256-GCM.
 *
 * Only the holder of the corresponding X25519 private key can decrypt.
 */
export interface SealedBox {
  /** Ephemeral X25519 public key used for ECDH (hex, no 0x prefix) */
  ephemeralPublicKey: string;
  /** AES-256-GCM initialisation vector (hex, 24 chars = 12 bytes) */
  iv: string;
  /** Encrypted payload with GCM auth tag appended (hex) */
  ciphertext: string;
}

// ---------------------------------------------------------------------------
// Order form schema
// ---------------------------------------------------------------------------

/** Supported order form field types */
export type OrderFieldType =
  | "text"
  | "email"
  | "tel"
  | "textarea"
  | "select"
  | "checkbox";

/**
 * Schema for a single field in an event's order form.
 * Organizers configure these at event creation time.
 * The embed widget and main app render them dynamically.
 */
export interface OrderField {
  /** Stable identifier used as the key in submitted form data */
  id: string;
  /** Input type — determines the rendered control */
  type: OrderFieldType;
  /** Human-readable label shown above the input */
  label: string;
  /** Whether the field must be filled before submission */
  required: boolean;
  /** Placeholder text inside the input */
  placeholder?: string;
  /** Options list — only used when type is "select" */
  options?: string[];
  /** Maximum character length — for "text" and "textarea" */
  maxLength?: number;
}
