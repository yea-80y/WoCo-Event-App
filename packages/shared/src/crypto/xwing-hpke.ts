/**
 * X-Wing as an HPKE KEM (RFC 9180 `KemInterface`), backed by the ONE X-Wing
 * implementation in `xwing.ts` (#642). HPKE then does what hand-assembled ECIES
 * used to: key schedule, `info` and `aad` binding and the AEAD, all to a spec.
 *
 * Follows the draft's "Use in HPKE" section (draft-connolly-cfrg-xwing-kem-10 §5.6):
 * KEM id 0x647a, Nsecret 32, Nenc 1120, Npk 1216, Nsk 32; keys serialize as their
 * raw bytes; DeriveKeyPair(ikm) = GenerateKeyPairDerand(SHAKE256(ikm, 32)); no
 * authenticated mode. The HPKE-level vector in `test/crypto/xwing.test.ts` was
 * cross-checked against an independent implementation.
 *
 * The ACCOUNT key never comes through `deriveKeyPair` — see
 * `deriveXWingKeypairFromSeed` for why there is exactly one route to it. The
 * escrow's guardian and portability keys do, as they did under DHKEM(X25519).
 */

import {
  DecapError,
  DeriveKeyPairError,
  DeserializeError,
  EncapError,
  InvalidParamError,
  KemId,
  KEM_USAGES,
  NotSupportedError,
  SerializeError,
  XCryptoKey,
  isCryptoKeyPair,
  type KemInterface,
  type RecipientContextParams,
  type SenderContextParams,
} from "@hpke/common";
import { shake256 } from "@noble/hashes/sha3.js";
import {
  xwing,
  XWING_CIPHERTEXT_BYTES,
  XWING_PUBLIC_KEY_BYTES,
  XWING_SEED_BYTES,
  XWING_SHARED_SECRET_BYTES,
} from "./xwing.js";

const ALG_NAME = "X-Wing";
/** The encapsulation randomness X-Wing takes: 32 for ML-KEM ‖ 32 for X25519. */
const ESEED_BYTES = 64;

function bytesOf(input: ArrayBufferLike | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
  }
  return new Uint8Array(input).slice();
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/** The raw bytes of one of OUR keys, or a throw. A CryptoKey from anywhere else
 *  (a WebCrypto key, another KEM's XCryptoKey) is refused, never reinterpreted. */
function rawKey(key: CryptoKey, type: "public" | "private", length: number): Uint8Array {
  if (!(key instanceof XCryptoKey) || key.algorithm.name !== ALG_NAME || key.type !== type) {
    throw new Error(`not an X-Wing ${type} key`);
  }
  if (key.key.byteLength !== length) throw new Error(`X-Wing ${type} key must be ${length} bytes`);
  return key.key;
}

export class XWingKem implements KemInterface {
  readonly id = KemId.XWing;
  readonly secretSize = XWING_SHARED_SECRET_BYTES;
  readonly encSize = XWING_CIPHERTEXT_BYTES;
  readonly publicKeySize = XWING_PUBLIC_KEY_BYTES;
  readonly privateKeySize = XWING_SEED_BYTES;

  async serializePublicKey(key: CryptoKey): Promise<ArrayBuffer> {
    try {
      return bufferOf(rawKey(key, "public", XWING_PUBLIC_KEY_BYTES));
    } catch (e) {
      throw new SerializeError(e);
    }
  }

  async deserializePublicKey(key: ArrayBufferLike | ArrayBufferView): Promise<CryptoKey> {
    const b = bytesOf(key);
    if (b.length !== XWING_PUBLIC_KEY_BYTES) {
      throw new DeserializeError(new Error(`X-Wing public key must be ${XWING_PUBLIC_KEY_BYTES} bytes`));
    }
    return new XCryptoKey(ALG_NAME, b, "public");
  }

  async serializePrivateKey(key: CryptoKey): Promise<ArrayBuffer> {
    try {
      return bufferOf(rawKey(key, "private", XWING_SEED_BYTES));
    } catch (e) {
      throw new SerializeError(e);
    }
  }

  async deserializePrivateKey(key: ArrayBufferLike | ArrayBufferView): Promise<CryptoKey> {
    const b = bytesOf(key);
    if (b.length !== XWING_SEED_BYTES) {
      throw new DeserializeError(new Error(`X-Wing private key must be ${XWING_SEED_BYTES} bytes`));
    }
    return new XCryptoKey(ALG_NAME, b, "private", KEM_USAGES);
  }

  /** Raw only. There is no JWK form of an X-Wing key we would ever need to accept. */
  async importKey(
    format: "raw" | "jwk",
    key: ArrayBuffer | JsonWebKey,
    isPublic = true,
  ): Promise<CryptoKey> {
    if (format !== "raw" || !(key instanceof ArrayBuffer || ArrayBuffer.isView(key))) {
      throw new NotSupportedError("X-Wing keys import as raw bytes only");
    }
    return isPublic ? this.deserializePublicKey(key) : this.deserializePrivateKey(key);
  }

  async generateKeyPair(): Promise<CryptoKeyPair> {
    return this.#pair(crypto.getRandomValues(new Uint8Array(XWING_SEED_BYTES)));
  }

  /** Draft §5.6: `sk = SHAKE256(ikm, 32)`, then the derandomized keygen. */
  async deriveKeyPair(ikm: ArrayBufferLike | ArrayBufferView): Promise<CryptoKeyPair> {
    return this.#pair(shake256(bytesOf(ikm), { dkLen: XWING_SEED_BYTES }));
  }

  async encap(params: SenderContextParams): Promise<{ sharedSecret: ArrayBuffer; enc: ArrayBuffer }> {
    if (params.senderKey !== undefined) {
      throw new NotSupportedError("X-Wing has no authenticated mode");
    }
    let eseed: Uint8Array | undefined;
    if (params.ekm !== undefined) {
      // A fixed encapsulation seed exists for test vectors only; production never
      // passes one, so every box gets fresh randomness from noble.
      if (isCryptoKeyPair(params.ekm)) throw new InvalidParamError("X-Wing ekm must be raw bytes");
      eseed = bytesOf(params.ekm);
      if (eseed.length !== ESEED_BYTES) throw new InvalidParamError(`X-Wing ekm must be ${ESEED_BYTES} bytes`);
    }
    try {
      const pk = rawKey(params.recipientPublicKey, "public", XWING_PUBLIC_KEY_BYTES);
      // noble runs the FIPS 203 modulus check on `pk` here and throws on a bad key.
      const { cipherText, sharedSecret } = xwing.encapsulate(pk, eseed);
      return { sharedSecret: bufferOf(sharedSecret), enc: bufferOf(cipherText) };
    } catch (e) {
      throw new EncapError(e);
    }
  }

  async decap(params: RecipientContextParams): Promise<ArrayBuffer> {
    if (params.senderPublicKey !== undefined) {
      throw new NotSupportedError("X-Wing has no authenticated mode");
    }
    const enc = bytesOf(params.enc);
    if (enc.length !== XWING_CIPHERTEXT_BYTES) {
      throw new InvalidParamError(`X-Wing enc must be ${XWING_CIPHERTEXT_BYTES} bytes`);
    }
    try {
      const recipient = isCryptoKeyPair(params.recipientKey)
        ? params.recipientKey.privateKey
        : params.recipientKey;
      const sk = rawKey(recipient, "private", XWING_SEED_BYTES);
      // ML-KEM rejects implicitly: a wrong key yields a wrong secret, not a throw,
      // so a mismatch surfaces as the AEAD's open failure — as it did before.
      return bufferOf(xwing.decapsulate(enc, sk));
    } catch (e) {
      throw new DecapError(e);
    }
  }

  async #pair(sk: Uint8Array): Promise<CryptoKeyPair> {
    try {
      const { secretKey, publicKey } = xwing.keygen(sk);
      return {
        privateKey: new XCryptoKey(ALG_NAME, secretKey, "private", KEM_USAGES),
        publicKey: new XCryptoKey(ALG_NAME, publicKey, "public"),
      };
    } catch (e) {
      throw new DeriveKeyPairError(e);
    }
  }
}
