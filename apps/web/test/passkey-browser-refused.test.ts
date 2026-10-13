/**
 * Firefox refuses passkeys on woco.eth.limo outright: `*.eth.limo` joined the
 * Public Suffix List on 2026-09-01 and Firefox refuses an RP ID that is a public
 * suffix even when it equals the host, with "SecurityError: The operation is
 * insecure." - which the login modal used to show verbatim. Runs the REAL
 * passkey-account code with a scripted authenticator that refuses the same way.
 *
 * MUTATION: call `navigator.credentials.get` directly in `_authenticatePasskeyImpl`
 * and the sign-in test goes red; drop the `rpId === window.location.hostname`
 * condition in `namedRefusal` and the other-RP test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";

const HOST = "woco.eth.limo";

// Restore and sign-in read IndexedDB only after a ceremony succeeds; an empty
// store is enough for every path here.
(globalThis as { indexedDB?: unknown }).indexedDB = {
  open: () => {
    const req: Record<string, unknown> = {};
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => ({}),
      transaction: () => ({
        objectStore: () => ({
          get: () => {
            const r: Record<string, unknown> = {};
            queueMicrotask(() => (r.onsuccess as ((e: unknown) => void) | undefined)?.({ target: r }));
            return r;
          },
        }),
      }),
      onclose: null,
    };
    queueMicrotask(() => {
      req.result = db;
      (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
    });
    return req;
  },
};

const refuse = async () => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};
Object.defineProperty(globalThis, "navigator", {
  value: { credentials: { get: refuse, create: refuse } },
  configurable: true,
  writable: true,
});
(globalThis as { window?: unknown }).window = { location: { hostname: HOST } };

const {
  authenticatePasskey,
  createPasskeyAccount,
  createPasskeyBackupKey,
  getPasskeyBackupKey,
  restorePasskeyAccount,
  PasskeyBrowserRefusedError,
} = await import("../src/lib/auth/passkey-account.ts");

function assertRefusal(e: unknown): true {
  assert.ok(e instanceof PasskeyBrowserRefusedError, `expected the named refusal, got ${String(e)}`);
  assert.match(e.message, /This browser can't use passkeys on woco\.eth\.limo\./);
  assert.equal(e.host, HOST, "the host travels with the error, for the sign-in sheet's advice");
  assert.ok(e.cause instanceof DOMException && e.cause.name === "SecurityError", "the raw refusal stays attached");
  return true;
}

test("sign-in: the raw refusal reads as one the user can act on", async () => {
  await assert.rejects(authenticatePasskey(), assertRefusal);
});

test("creating an account, and a backup passkey, read the same", async () => {
  await assert.rejects(createPasskeyAccount(), assertRefusal);
  await assert.rejects(createPasskeyBackupKey(), assertRefusal);
});

test("the backup read and the unlock of a pinned passkey read the same", async () => {
  await assert.rejects(getPasskeyBackupKey(), assertRefusal);
  await assert.rejects(
    restorePasskeyAccount({ retryDiscoverable: false, credential: { credentialId: "AQ", rpId: HOST } }),
    assertRefusal,
  );
});

test("a refusal for ANOTHER RP ID is not renamed: that one is a mismatch, not this browser", async () => {
  await assert.rejects(
    restorePasskeyAccount({ retryDiscoverable: false, credential: { credentialId: "AQ", rpId: "gateway.woco-net.com" } }),
    (e: unknown) => {
      assert.ok(e instanceof DOMException && e.name === "SecurityError", `expected the raw error, got ${String(e)}`);
      return true;
    },
  );
});
