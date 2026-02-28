import { para } from "./para-client.js";

/**
 * Start the Para email authentication flow.
 * Calls onUrl with the hosted auth URL to display in an iframe.
 * Returns the wallet address once authentication completes.
 */
export async function authenticateWithPara(
  email: string,
  onUrl: (url: string, isNewUser: boolean) => void,
  isCanceled: () => boolean,
): Promise<{ address: string }> {
  const authState = await para.signUpOrLogIn({ auth: { email } });

  if (authState.stage !== "verify" || !authState.loginUrl) {
    throw new Error("Unexpected Para auth state: " + authState.stage);
  }

  const isNewUser = authState.nextStage === "signup";
  onUrl(authState.loginUrl, isNewUser);

  if (isNewUser) {
    await para.waitForWalletCreation({ isCanceled });
  } else {
    await para.waitForLogin({ isCanceled });
  }

  const address = await _getParaAddress();
  if (!address) throw new Error("No Para wallet found after authentication");
  return { address };
}

/**
 * Check if a Para session is still active and return the address.
 * Returns null if no active session.
 */
export async function restoreParaSession(): Promise<{ address: string } | null> {
  try {
    // para.isSessionActive() can hang on network requests — cap at 3 s
    const isActive = await Promise.race([
      para.isSessionActive(),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    if (!isActive) return null;

    const address = await _getParaAddress();
    if (!address) return null;
    return { address };
  } catch {
    return null;
  }
}

export async function logoutPara(): Promise<void> {
  try {
    await para.logout();
  } catch {
    // ignore — best effort
  }
}

async function _getParaAddress(): Promise<string | null> {
  // Wallet address may take a moment to populate after waitForLogin/waitForWalletCreation.
  // Retry a few times with backoff before giving up.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const wallets = Object.values(para.wallets).filter(
        (w) => w.type === "EVM" && w.address,
      );
      const addr = wallets[0]?.address;
      if (addr && typeof addr === "string") {
        return addr.toLowerCase();
      }
    } catch {
      // continue to retry
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  return null;
}
