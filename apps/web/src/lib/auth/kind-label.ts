/**
 * How an account signs in, as a person reads it: the profile header's badge and
 * the Sign-in row on Account & security show the same words.
 */

export const authKindLabel: Record<string, string> = {
  web3: "Web3 Wallet",
  passkey: "Passkey",
  web3auth: "Email / Social Login",
  coinbase: "Coinbase Smart Wallet",
};

export const authKindColor: Record<string, string> = {
  web3: "#C7F23A",
  passkey: "#22c55e",
  web3auth: "#38bdf8",
  coinbase: "#2563eb",
};
