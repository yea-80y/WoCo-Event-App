/**
 * Type augmentation for the WebAuthn PRF extension.
 * The PRF extension is not yet in lib.dom.d.ts, so we declare the
 * additional properties here.
 */

interface AuthenticationExtensionsClientInputs {
  prf?: {
    eval?: {
      first: BufferSource;
      second?: BufferSource;
    };
    evalByCredential?: Record<
      string,
      { first: BufferSource; second?: BufferSource }
    >;
  };
}

interface AuthenticationExtensionsClientOutputs {
  prf?: {
    enabled?: boolean;
    results?: {
      first?: ArrayBuffer;
      second?: ArrayBuffer;
    };
  };
}
