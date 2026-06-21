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
 *  - ESCROW (setup + recovery): derive the X25519 escrow key from a deterministic
 *    EIP-712 signature → `signTypedData`. Every wallet can do this.
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
  /** EIP-712 typed-data signer — derives the escrow X25519 key (setup + recovery). */
  signTypedData: EIP712Signer;
  /**
   * Build the viem `Signer` (OneOf<EIP1193Provider | WalletClient | LocalAccount |
   * SmartAccount>) that signs the guardian userOp during `recoverAccount`. Absent
   * ⇒ this backup cannot complete a recovery yet (see `recoveryReady`).
   */
  getGuardianSigner?: () => Promise<unknown>;
  /** True iff `getGuardianSigner` is available → safe to install as a real backup. */
  recoveryReady: boolean;
}

/**
 * Build a `BackupWallet` from a raw secp256k1 private key. The viem `LocalAccount`
 * is self-sufficient (it embeds the key), so it serves BOTH roles with no further
 * dependency on whatever produced the key:
 *  - escrow: viem `signTypedData` is RFC6979-deterministic, so the same key always
 *    re-derives the SAME X25519 escrow key on any device — the property recovery
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

  // primaryType = the single type key, matching the escrow caller + requestPodIdentity.
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
  const web3auth = new mod.Web3Auth(buildWeb3AuthOptions(mod, clientId));
  await web3auth.init();

  // Opens the Web3Auth modal (email + socials). Returns null if the user closes it.
  const provider = await web3auth.connect();
  if (!provider) {
    throw new Error("Email backup sign-in was cancelled.");
  }

  try {
    const raw = await extractRawPrivateKey(provider);
    return await backupWalletFromPrivateKey(raw);
  } finally {
    // The modal does NOT auto-close after connect() — it sits on a "connected"
    // success state. The logout below emits DISCONNECTED, which the modal reacts to
    // by resetting to its LOGIN page (looks like the flow bounced back to sign-in).
    // So hide the modal first; then the logout's state change lands on an already
    // closed modal. Internal field, guarded — a future SDK shape change just falls
    // back to the prior (cosmetic) behaviour.
    try {
      (web3auth as unknown as { loginModal?: { closeModal?: () => void } }).loginModal?.closeModal?.();
    } catch {
      /* best effort */
    }
    // Clear the Web3Auth session: the LocalAccount already holds the key, so the
    // instance is no longer needed, and a backup factor must not stay connected
    // (it shares this clientId with the primary email login). Non-fatal — the key
    // is already extracted by here.
    try {
      await web3auth.logout({ cleanup: true });
    } catch {
      /* ignore — session cleanup is best-effort */
    }
  }
}
