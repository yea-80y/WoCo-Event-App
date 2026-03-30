/**
 * Wallet connection state using Svelte 5 runes.
 * Supports MetaMask and any injected EIP-1193 provider.
 */
import { BrowserProvider, type Signer } from "ethers";

let _address = $state<string | null>(null);
let _provider = $state<BrowserProvider | null>(null);
let _signer = $state<Signer | null>(null);
let _chainId = $state<number | null>(null);
let _connecting = $state(false);
let _error = $state<string | null>(null);

export const wallet = {
  get address() { return _address; },
  get provider() { return _provider; },
  get signer() { return _signer; },
  get chainId() { return _chainId; },
  get connecting() { return _connecting; },
  get error() { return _error; },
  get connected() { return _address !== null; },
};

export async function connectWallet(): Promise<boolean> {
  if (_connecting) return false;
  _error = null;

  const ethereum = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>; on: (event: string, handler: (...args: unknown[]) => void) => void } }).ethereum;
  if (!ethereum) {
    _error = "No wallet detected. Install MetaMask or another Ethereum wallet.";
    return false;
  }

  _connecting = true;

  try {
    const provider = new BrowserProvider(ethereum);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    const address = await signer.getAddress();
    const network = await provider.getNetwork();

    _provider = provider;
    _signer = signer;
    _address = address;
    _chainId = Number(network.chainId);

    // Listen for account/chain changes
    ethereum.on("accountsChanged", (accounts: unknown) => {
      const accs = accounts as string[];
      if (accs.length === 0) {
        disconnect();
      } else {
        _address = accs[0];
        // Re-init signer
        if (_provider) {
          _provider.getSigner().then(s => { _signer = s; });
        }
      }
    });

    ethereum.on("chainChanged", () => {
      // Reload on chain change for simplicity
      window.location.reload();
    });

    _connecting = false;
    return true;
  } catch (err) {
    _error = err instanceof Error ? err.message : "Failed to connect wallet";
    _connecting = false;
    return false;
  }
}

export function disconnect() {
  _address = null;
  _provider = null;
  _signer = null;
  _chainId = null;
  _error = null;
}
