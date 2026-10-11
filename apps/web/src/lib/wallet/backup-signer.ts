import { BrowserProvider } from "ethers";
import type { EIP712Signer } from "@woco/shared";
import { buildWeb3AuthOptions, extractRawPrivateKey } from "../auth/web3auth-config";

/**
 * Connect an EXTERNAL "backup wallet" for account recovery and expose it as a
 * provider-agnostic `BackupWallet`. This is intentionally separate from the
 * session wallet plumbing: the backup is a wallet the user controls elsewhere
 * (an injected wallet, or an email wallet) that acts as their recovery key. It
 * only ever SIGNS — it never becomes the logged-in identity.
 *
 * A backup plays TWO crypto roles, which need different signing capabilities:
 *  - ESCROW (setup + recovery): derive the X-Wing escrow key from a deterministic
 *    EIP-712 signature → `signTypedData`. Every wallet can do this. (A passkey
 *    backup derives it from its PRF output instead — `deriveEscrowKeys`, #642.)
 *  - GUARDIAN (recovery only): sign the weighted-ECDSA guardian userOp that calls
 *    `target.doRecovery` → a viem/EIP-1193 `Signer`. NOT every provider exposes
 *    one, so it is OPTIONAL and gated by `recoveryReady`. A backup that is not
 *    `recoveryReady` can be derived but MUST NOT be installed as a real backup —
 *    that would trap the user with an account they can never recover.
 *
 * SIGNER-SOURCE MODEL: every factor (injected wallet, email wallet, and later a
 * device/file key or a friend's wallet) is just a *source of a signer* feeding
 * the SAME `BackupWallet` seam and the SAME on-chain weighted-ECDSA guardian
 * ceremony. `backupWalletFromPrivateKey` is the shared core for any source that
 * resolves to a raw secp256k1 key (Web3Auth now; device/file later).
 */
export interface BackupWallet {
  address: string;
  /** EIP-712 typed-data signer — derives the escrow keys (setup + recovery) for every
   *  kind that has no `deriveEscrowKeys` of its own. */
  signTypedData: EIP712Signer;
  /**
   * A PASSKEY backup's own escrow-key derivation, from its PRF output rather than a
   * signature (#642). When present it is the ONLY route — `deriveGuardianKeysForBackup`
   * never falls back to signing for such a backup.
   */
  deriveEscrowKeys?: () => Promise<import("../auth/recovery-escrow.js").GuardianKeys>;
  /**
   * Build the viem `Signer` (OneOf<EIP1193Provider | WalletClient | LocalAccount |
   * SmartAccount>) that signs the guardian userOp during `recoverAccount`. Absent
   * ⇒ this backup cannot complete a recovery yet (see `recoveryReady`).
   */
  getGuardianSigner?: () => Promise<unknown>;
  /** True iff `getGuardianSigner` is available → safe to install as a real backup. */
  recoveryReady: boolean;
  /**
   * Non-PII provider category for the backup-inventory memory-jog (e.g. "google",
   * "email_passwordless") — set for email/social backups from Web3Auth
   * `typeOfLogin`. Absent for injected wallets / passkeys.
   */
  providerLabel?: string;
}

/**
 * Build a `BackupWallet` from a raw secp256k1 private key. The viem `LocalAccount`
 * is self-sufficient (it embeds the key), so it serves BOTH roles with no further
 * dependency on whatever produced the key:
 *  - escrow: viem `signTypedData` is RFC6979-deterministic, so the same key always
 *    re-derives the SAME escrow key on any device — the property recovery
 *    depends on (the setup self-check still verifies it before any irreversible step).
 *  - guardian: a `LocalAccount` is directly a viem `Signer`, and the weighted-ECDSA
 *    approval is an EIP-191 personal_sign it can produce → `recoveryReady: true`.
 *
 * The caller owns the key's lifetime. We never persist or log it; it lives only
 * inside the returned closures. (Raw strings can't be zeroed in JS — an inherent
 * limit; we minimise copies and keep it out of any store.)
 */
export async function backupWalletFromPrivateKey(privateKey: string): Promise<BackupWallet> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("Backup key is malformed — expected a 32-byte secp256k1 private key.");
  }
  const account = privateKeyToAccount(pk);

  // primaryType = the single type key, matching the escrow caller + requestIdentitySeed.
  const signTypedData: EIP712Signer = (domain, types, value) =>
    account.signTypedData({
      domain: domain as Parameters<typeof account.signTypedData>[0]["domain"],
      types: types as Parameters<typeof account.signTypedData>[0]["types"],
      primaryType: Object.keys(types)[0],
      message: value,
    });

  return {
    address: account.address.toLowerCase(),
    signTypedData,
    // A LocalAccount IS a viem Signer (∈ the guardian-signer OneOf) — return it directly.
    getGuardianSigner: async () => account,
    recoveryReady: true,
  };
}

/**
 * PASSKEY backup. The friendly factor for a web3auth (email/social) user with a
 * phone but no crypto wallet: a dedicated recovery passkey whose PRF-derived key
 * becomes the guardian. Its ON-CHAIN guardian key reuses the SAME keccak256(PRF)
 * construction as the primary passkey login, so it flows through
 * `backupWalletFromPrivateKey`; its ESCROW keys come from the PRF-rooted escrow
 * master instead of a signature (#642), so the seed it guards is not one secp256k1
 * break away.
 *
 *  - mode "create" (SETUP): mints a new "WoCo Backup" passkey. A fresh credential
 *    guarantees independence from the primary (its address can't collide), and the
 *    caller's own-key block is the backstop.
 *  - mode "get" (RECOVERY): discoverable picker re-derives the SAME key from the
 *    same credential. A wrong pick fails safe (guardian address won't match escrow).
 *
 * Neither mode touches StorageKeys.PASSKEY_CREDENTIAL (see passkey-account.ts) — a
 * backup ceremony must never clobber a live primary-passkey session's restore slot.
 *
 * ⚠️ PORTABILITY: this is only a real cross-device backup if the passkey SYNCS
 * (iCloud Keychain / Google Password Manager / a password manager). A device-bound
 * passkey dies with the device — the UI must steer users to a synced authenticator.
 */
export async function connectPasskeyBackup(mode: "create" | "get" = "create"): Promise<BackupWallet> {
  const { isPasskeySupported, createPasskeyBackupKey, getPasskeyBackupKey } = await import(
    "../auth/passkey-account.js"
  );
  if (!isPasskeySupported()) {
    throw new Error("This device can't create passkeys. Use a crypto wallet or email backup instead.");
  }
  const { privateKey, escrowMaster } =
    mode === "create" ? await createPasskeyBackupKey() : await getPasskeyBackupKey();
  const wallet = await backupWalletFromPrivateKey(privateKey);
  return {
    ...wallet,
    // Setup derives twice (the determinism self-check), so the master is kept for
    // the backup's lifetime — like the owner key, it lives only in this closure.
    deriveEscrowKeys: async () => {
      const { guardianKeysFromMaster } = await import("../auth/recovery-escrow.js");
      return guardianKeysFromMaster(escrowMaster);
    },
  };
}

/**
 * INJECTED-WALLET backup (MetaMask et al). For crypto-comfortable users.
 *
 * We talk to the injected provider directly (a fresh BrowserProvider) so this
 * cannot disturb a passkey session that has no injected wallet attached.
 */
export async function connectBackupWallet(): Promise<BackupWallet> {
  const injected = (globalThis as { ethereum?: unknown }).ethereum;
  if (!injected) {
    throw new Error("No wallet found. Install a browser wallet (e.g. MetaMask) to use as your backup.");
  }

  const provider = new BrowserProvider(injected as ConstructorParameters<typeof BrowserProvider>[0]);
  // Prompt the user to pick the account that will be their backup.
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = (await signer.getAddress()).toLowerCase();

  const signTypedData: EIP712Signer = (domain, types, value) =>
    signer.signTypedData(
      domain as Parameters<typeof signer.signTypedData>[0],
      types as Parameters<typeof signer.signTypedData>[1],
      value as Parameters<typeof signer.signTypedData>[2],
    );

  // Guardian signer: a viem WalletClient bound to the chosen account, talking to
  // the same injected provider. weighted-ECDSA signs the approval as an EIP-191
  // personal_sign (chain-agnostic), so we do NOT force a chain switch here.
  const getGuardianSigner = async () => {
    const [{ createWalletClient, custom }, { arbitrumSepolia }] = await Promise.all([
      import("viem"),
      import("viem/chains"),
    ]);
    return createWalletClient({
      account: address as `0x${string}`,
      chain: arbitrumSepolia,
      transport: custom(injected as Parameters<typeof custom>[0]),
    });
  };

  return { address, signTypedData, getGuardianSigner, recoveryReady: true };
}

/**
 * EMAIL-WALLET backup via Web3Auth (PnP Modal SDK). The friendly factor for users
 * with no second device / no injected wallet: log in by email, get back a stable
 * key. Web3Auth PnP reconstructs a standard secp256k1 key CLIENT-SIDE (device +
 * network shares) and the CommonPrivateKeyProvider exposes it via `private_key`
 * (see web3auth-config — OTHER namespace) — so we receive a RAW KEY and viem owns
 * determinism (RFC6979), exactly as the headless spike proved
 * (apps/web/scripts/web3auth-backup-spike.ts). The Web3Auth branch is therefore
 * just `backupWalletFromPrivateKey` fed by the email login.
 *
 * SESSION SAFETY: we create our OWN Web3Auth instance, extract the key into a
 * self-sufficient `LocalAccount`, then log that instance out — this connector
 * never imports or mutates the auth-store, so it cannot hijack the logged-in
 * identity (the trap that ruled out reusing ParaLogin). The independence guard
 * (a user whose PRIMARY login is the email wallet may not also use it as their
 * guardian) is enforced by the caller/UI, so a backup login won't collide with a
 * primary Web3Auth session sharing this clientId.
 *
 * 🔴 FUNDS-CRITICAL CONFIG INVARIANT: the returned key is a deterministic function
 * of (user login) × VITE_WEB3AUTH_CLIENT_ID × network. Changing the clientId or
 * the network CHANGES EVERY USER'S BACKUP KEY and orphans every escrow envelope
 * sealed to the old key — the same blast radius as rotating FEED_PRIVATE_KEY. Pin
 * both for production; never repoint a live deployment.
 */
export async function connectWeb3AuthBackup(): Promise<BackupWallet> {
  const clientId = import.meta.env.VITE_WEB3AUTH_CLIENT_ID as string | undefined;
  if (!clientId) {
    throw new Error("Email backup isn't configured yet (missing VITE_WEB3AUTH_CLIENT_ID).");
  }

  // Lazy-load the heavy SDK so it never enters the main bundle. Config (network,
  // OTHER-namespace chain so the raw key is reachable, no injected discovery) is
  // shared with the primary login via buildWeb3AuthOptions — keep it single-source.
  const mod = await import("@web3auth/modal");
  type Survivor = import("../auth/web3auth-survivor.js").Web3AuthSessionInstance;
  const { adaptWeb3AuthSdk } = await import("../auth/web3auth-sdk-adapter.js");
  type Instance = import("../auth/web3auth-sdk-adapter.js").Web3AuthInstance;
  type V11 = import("../auth/web3auth-sdk-adapter.js").Web3AuthV11Like;
  // v11 is presented in the v10 shape (web3auth-sdk-adapter.ts): connect() resolves
  // with the auth connector's key provider, as the primary login reads it.
  const build = async (): Promise<Instance> => {
    const fresh = adaptWeb3AuthSdk(new mod.Web3Auth(buildWeb3AuthOptions(mod, clientId)) as unknown as V11);
    await fresh.init();
    return fresh;
  };
  // The survivor-relevant slice of the instance (same cast the login side uses —
  // `cachedConnector` isn't in the SDK's public typings).
  const asSurvivor = (i: Instance) => i as unknown as Survivor;
  let web3auth = await build();

  // #307: this instance shares clientId AND localStorage with the primary email
  // login, so a session surviving there rehydrates HERE, and connect() can then
  // resolve as the survivor — no modal, no OTP. At setup that identity would be
  // registered as the on-chain guardian and the escrow sealed to it: on a shared
  // device, a stranger's takeover power recorded as a deliberate choice.
  // Choosing a guardian must always be an explicit authentication, so end any
  // survivor first — and refuse rather than adopt when it cannot be ended.
  // The instance that ended a survivor is swapped for a fresh one (#803): its
  // login connector is dead after the logout, and the modal would not say so.
  const { instanceForExplicitSignIn, SURVIVOR_STILL_LOADING_MESSAGE } = await import("../auth/web3auth-survivor.js");
  const { markWeb3AuthSessionEstablished, clearWeb3AuthSessionFlag } = await import(
    "../auth/web3auth-session-flag.js"
  );
  try {
    const ready = await instanceForExplicitSignIn(asSurvivor(web3auth), async () => asSurvivor(await build()));
    web3auth = ready as unknown as Instance;
  } catch (e) {
    if (e instanceof Error && e.message === SURVIVOR_STILL_LOADING_MESSAGE) throw e;
    throw new Error(
      "Couldn't clear a previous email session, so the backup sign-in can't run safely — check your connection and try again.",
    );
  }
  const w = asSurvivor(web3auth);
  // The modal does NOT close itself: it sits on a "connected" success screen, and
  // after an error (popup closed or blocked) it stays open although connect()
  // has rejected - a second tap there completes a sign-in nothing receives,
  // and that stray session would outlive sign-out (no flag is set for it).
  // So close it the moment connect() settles, either way (#803). Internal
  // field, guarded - a future SDK shape change only loses the close.
  const closeModal = () => {
    try {
      (web3auth as unknown as { loginModal?: { closeModal?: () => void } }).loginModal?.closeModal?.();
    } catch {
      /* best effort */
    }
  };

  // Opens the Web3Auth modal (email + socials). Returns null if the user closes it.
  let provider: Awaited<ReturnType<typeof web3auth.connect>>;
  try {
    provider = await web3auth.connect();
  } catch (e) {
    // Defence in depth: a session hydrating mid-modal can close it and reject —
    // while the instance quietly becomes connected as the survivor. Same race
    // the primary login guards (#182): never adopt it, end it and ask for one
    // retry (which builds fresh instances, so the spent one is never reused).
    // `connected` (the stored name) is deliberately the wider read here, not
    // `isWeb3AuthSessionLive`: anything the SDK still names is ended or refused,
    // and a logout it cannot run is swallowed.
    if (w.connected) {
      try {
        await w.logout({ cleanup: true });
      } catch {
        /* the retry's pre-modal ending gets another attempt */
      }
      throw new Error("A previous email session interfered with the backup sign-in — please try again.");
    }
    throw e instanceof Error ? e : new Error("Email backup sign-in was cancelled.");
  } finally {
    closeModal();
  }
  if (!provider) {
    throw new Error("Email backup sign-in was cancelled.");
  }
  // A session now exists in shared storage. The flag keeps sign-out honest if
  // the cleanup logout below fails (its contract: set when a key is extracted,
  // cleared only when the stored session is known ended).
  markWeb3AuthSessionEstablished();

  try {
    const raw = await extractRawPrivateKey(provider);
    const wallet = await backupWalletFromPrivateKey(raw);
    // Capture the provider CATEGORY (not PII) while the session is live, for the
    // backup-inventory memory-jog. "google" | "email_passwordless" | … — a
    // category, never the email address (v11 names it authConnection, v10
    // typeOfLogin). Best-effort.
    let providerLabel: string | undefined;
    try {
      const info = (await web3auth.getUserInfo()) as { authConnection?: string; typeOfLogin?: string };
      providerLabel = info?.authConnection || info?.typeOfLogin || undefined;
    } catch {
      /* label is a nicety — never block the backup on it */
    }
    return { ...wallet, providerLabel };
  } finally {
    // The modal was closed when connect() settled, so the logout's DISCONNECTED
    // (which resets the modal to its LOGIN page) lands on a closed modal.
    // Clear the Web3Auth session: the LocalAccount already holds the key, so the
    // instance is no longer needed, and a backup factor must not stay connected
    // (it shares this clientId with the primary email login). Non-fatal — the key
    // is already extracted by here, and on failure the flag set above stays, so
    // sign-out / the next explicit email authentication ends the leftover (#307).
    try {
      await web3auth.logout({ cleanup: true });
      clearWeb3AuthSessionFlag();
    } catch {
      /* ignore — session cleanup is best-effort */
    }
  }
}
