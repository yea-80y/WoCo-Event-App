import EthereumProvider from "@walletconnect/ethereum-provider";
import { setWalletConnectProvider } from "./provider.js";
import type { EthereumProvider as IEthereumProvider } from "./types.js";

const WC_PROJECT_ID = "6fef63322c22adc1e92e3b84836e256d";

let _wc: InstanceType<typeof EthereumProvider> | null = null;

async function _init(): Promise<InstanceType<typeof EthereumProvider>> {
  if (_wc) return _wc;
  _wc = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    chains: [1],
    showQrModal: true,
    methods: ["eth_requestAccounts", "eth_accounts", "eth_signTypedData_v4"],
    events: ["accountsChanged", "chainChanged", "disconnect"],
  });
  return _wc;
}

export async function connectViaWalletConnect(): Promise<string | null> {
  const wc = await _init();
  await wc.connect();
  const accounts = wc.accounts;
  if (!accounts?.length) return null;
  setWalletConnectProvider(wc as unknown as IEthereumProvider);
  return accounts[0].toLowerCase();
}

/**
 * Silently restore an existing WC session on page load.
 * Returns address if a live session exists, null otherwise. No UI shown.
 */
export async function tryRestoreWalletConnectSession(): Promise<string | null> {
  try {
    const wc = await _init();
    if (wc.accounts?.length) {
      setWalletConnectProvider(wc as unknown as IEthereumProvider);
      return wc.accounts[0].toLowerCase();
    }
  } catch {
    // no session
  }
  return null;
}

export async function disconnectWalletConnect(): Promise<void> {
  if (_wc) {
    await _wc.disconnect().catch(() => {});
    _wc = null;
  }
  setWalletConnectProvider(null);
}
